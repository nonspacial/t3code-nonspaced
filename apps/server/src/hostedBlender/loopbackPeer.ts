// @effect-diagnostics nodeBuiltinImport:off - the kernel's word order is the host's.
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

// Whether a loopback TCP peer belongs to this OS account. Loopback TCP carries no peer
// credentials, so the client's end is looked up in /proc/net/tcp{,6}. The rules are the same as
// the control add-on's in agentGuard.ts; change both together.

const LOOPBACK_TCP_TABLES: ReadonlyArray<string> = ["/proc/net/tcp", "/proc/net/tcp6"];

const TCP_ESTABLISHED = "01";
const IPV4_MAPPED_PREFIX = "00000000000000000000ffff";

export interface TcpEndpoint {
  /** The address's bytes as lowercase hex; an IPv4-mapped IPv6 address is its IPv4 address. */
  readonly address: string;
  readonly port: number;
}

export interface TcpRow {
  readonly local: TcpEndpoint;
  readonly remote: TcpEndpoint;
  readonly state: string;
  readonly uid: number;
  readonly inode: number;
}

const unmapped = (hex: string) =>
  hex.startsWith(IPV4_MAPPED_PREFIX) && hex.length === 32 ? hex.slice(24) : hex;

// "0100007F:1F90": the address as the kernel's 32-bit words in host byte order, then the port.
const procEndpoint = (text: string): TcpEndpoint | null => {
  const [address, port] = text.split(":");
  if (address === undefined || port === undefined || !/^(?:[0-9A-F]{8}){1,4}$/i.test(address)) {
    return null;
  }
  const littleEndian = NodeOS.endianness() === "LE";
  let hex = "";
  for (let index = 0; index < address.length; index += 8) {
    const word = address.slice(index, index + 8).toLowerCase();
    hex += littleEndian ? (word.match(/../g) ?? []).toReversed().join("") : word;
  }
  const parsedPort = Number.parseInt(port, 16);
  return Number.isInteger(parsedPort) ? { address: unmapped(hex), port: parsedPort } : null;
};

export const parseTcpTable = (text: string): ReadonlyArray<TcpRow> =>
  text
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const local = procEndpoint(fields[1] ?? "");
      const remote = procEndpoint(fields[2] ?? "");
      const uid = Number(fields[7]);
      const inode = Number(fields[9]);
      if (local === null || remote === null || fields[3] === undefined) return [];
      if (!Number.isInteger(uid) || !Number.isInteger(inode)) return [];
      return [{ local, remote, state: fields[3], uid, inode }];
    });

const ipv4Hex = (address: string): string | null => {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256))
    return null;
  return parts.map((part) => Number(part).toString(16).padStart(2, "0")).join("");
};

/** An address as Node reports it ("127.0.0.1", "::1", "::ffff:127.0.0.1"), as row hex. */
export const addressHex = (address: string): string | null => {
  const v4 = ipv4Hex(address);
  if (v4 !== null) return v4;
  const zoneless = address.split("%")[0] ?? "";
  let groups = zoneless.split(":");
  const last = groups.at(-1) ?? "";
  if (last.includes(".")) {
    const tail = ipv4Hex(last);
    if (tail === null) return null;
    groups = [...groups.slice(0, -1), tail.slice(0, 4), tail.slice(4)];
  }
  const gap = groups.indexOf("");
  if (gap !== -1) {
    const before = groups.slice(0, gap).filter(Boolean);
    const after = groups.slice(gap).filter(Boolean);
    groups = [
      ...before,
      ...Array.from({ length: 8 - before.length - after.length }, () => "0"),
      ...after,
    ];
  }
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return unmapped(groups.map((group) => group.toLowerCase().padStart(4, "0")).join(""));
};

const sameEndpoint = (a: TcpEndpoint, b: TcpEndpoint) =>
  a.address === b.address && a.port === b.port;

/** The one established socket with an inode; an orphaned or closing one lists uid and inode 0. */
const liveRow = (
  rows: ReadonlyArray<TcpRow>,
  local: TcpEndpoint,
  remote: TcpEndpoint,
): TcpRow | null => {
  const matches = rows.filter(
    (row) => sameEndpoint(row.local, local) && sameEndpoint(row.remote, remote),
  );
  const row = matches.length === 1 ? matches[0] : undefined;
  return row !== undefined && row.state === TCP_ESTABLISHED && row.inode !== 0 ? row : null;
};

export interface LoopbackConnection {
  readonly remoteAddress?: string | undefined;
  readonly remotePort?: number | undefined;
  readonly localAddress?: string | undefined;
  readonly localPort?: number | undefined;
}

/**
 * Whether the client of an accepted loopback connection runs as this OS account. Anything in
 * doubt (no row, several, a closing one, an unreadable table) is a no.
 */
export const isSameAccountPeer = Effect.fn("HostedBlender.isSameAccountPeer")(function* (
  connection: LoopbackConnection,
  options?: { readonly tables?: ReadonlyArray<string>; readonly uid?: number },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const uid = options?.uid ?? process.getuid?.();
  const peerAddress = connection.remoteAddress && addressHex(connection.remoteAddress);
  const ourAddress = connection.localAddress && addressHex(connection.localAddress);
  if (uid === undefined || !peerAddress || !ourAddress) return false;
  if (connection.remotePort === undefined || connection.localPort === undefined) return false;
  const peer = { address: peerAddress, port: connection.remotePort };
  const ours = { address: ourAddress, port: connection.localPort };
  const readRows = Effect.forEach(options?.tables ?? LOOPBACK_TCP_TABLES, (table) =>
    fileSystem.readFileString(table).pipe(Effect.orElseSucceed(() => "")),
  ).pipe(Effect.map((texts) => texts.flatMap(parseTcpTable)));
  const client = liveRow(yield* readRows, peer, ours);
  if (client === null) return false;
  // Read again: with our end still established, the row read was this connection's client.
  const again = yield* readRows;
  const still = liveRow(again, peer, ours);
  if (liveRow(again, ours, peer) === null || still === null || still.inode !== client.inode) {
    return false;
  }
  return still.uid === uid && client.uid === uid;
});
