// @effect-diagnostics nodeBuiltinImport:off - the kernel's word order is the host's, and a socket's inode comes from its fd.
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";
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
  if (address === undefined || port === undefined) return null;
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{32})$/i.test(address) || !/^[0-9A-F]{4}$/i.test(port)) return null;
  const littleEndian = NodeOS.endianness() === "LE";
  let hex = "";
  for (let index = 0; index < address.length; index += 8) {
    const word = address.slice(index, index + 8).toLowerCase();
    hex += littleEndian ? (word.match(/../g) ?? []).toReversed().join("") : word;
  }
  const parsedPort = Number.parseInt(port, 16);
  return Number.isInteger(parsedPort) ? { address: unmapped(hex), port: parsedPort } : null;
};

/** Null when any row doesn't parse: a table in doubt proves nothing. */
export const parseTcpTable = (text: string): ReadonlyArray<TcpRow> | null => {
  const rows: Array<TcpRow> = [];
  for (const line of text.split("\n").slice(1)) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/);
    const local = procEndpoint(fields[1] ?? "");
    const remote = procEndpoint(fields[2] ?? "");
    const [state, uid, inode] = [fields[3] ?? "", fields[7] ?? "", fields[9] ?? ""];
    if (local === null || remote === null || !/^[0-9A-F]{2}$/i.test(state)) return null;
    if (!/^\d+$/.test(uid) || !/^\d+$/.test(inode)) return null;
    rows.push({ local, remote, state, uid: Number(uid), inode: Number(inode) });
  }
  return rows;
};

/** The inode the kernel lists an open socket under, from its file descriptor. */
export const socketInode = (socket: NodeNet.Socket): number | null => {
  const fd = (socket as unknown as { readonly _handle?: { readonly fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return null;
  try {
    return NodeFS.fstatSync(fd).ino;
  } catch {
    return null;
  }
};

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

/**
 * Whether the client of a connection accepted on a loopback listener runs as this OS account.
 * Our end is found by the accepted socket's own inode, so a reused address and port can't stand
 * in for it. Anything in doubt (no row, several, a closing one, a table that doesn't parse) is a no.
 */
export const isSameAccountPeer = Effect.fn("HostedBlender.isSameAccountPeer")(function* (
  socket: NodeNet.Socket,
  options?: { readonly tables?: ReadonlyArray<string>; readonly uid?: number },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const uid = options?.uid ?? process.getuid?.();
  const inode = socketInode(socket);
  const peerAddress = socket.remoteAddress && addressHex(socket.remoteAddress);
  const ourAddress = socket.localAddress && addressHex(socket.localAddress);
  if (uid === undefined || inode === null || !peerAddress || !ourAddress) return false;
  if (socket.remotePort === undefined || socket.localPort === undefined) return false;
  const peer = { address: peerAddress, port: socket.remotePort };
  const ours = { address: ourAddress, port: socket.localPort };
  const readings: Array<TcpRow> = [];
  // Read twice: with our end still established, the row read was this connection's client.
  for (let reading = 0; reading < 2; reading++) {
    const texts = yield* Effect.forEach(options?.tables ?? LOOPBACK_TCP_TABLES, (table) =>
      fileSystem.readFileString(table).pipe(Effect.orElseSucceed(() => "")),
    );
    const tables = texts.map(parseTcpTable);
    if (tables.some((rows) => rows === null)) return false;
    const rows = tables.flatMap((table) => table ?? []);
    const own = liveRow(rows, ours, peer);
    const client = liveRow(rows, peer, ours);
    if (own === null || own.inode !== inode || client === null) return false;
    readings.push(client);
  }
  const [first, second] = readings;
  return (
    first !== undefined &&
    second !== undefined &&
    first.inode === second.inode &&
    first.uid === second.uid &&
    first.state === second.state &&
    first.uid === uid
  );
});
