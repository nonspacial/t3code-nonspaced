// @effect-diagnostics nodeBuiltinImport:off - real loopback sockets and faked kernel tables.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { addressHex, isSameAccountPeer, parseTcpTable, socketInode } from "./loopbackPeer.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/** A connection accepted on a real loopback listener, and its client. */
const accepted = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: NodeNet.Server; client: NodeNet.Socket; socket: NodeNet.Socket }>(
        (resolve) => {
          const server = NodeNet.createServer((socket) => resolve({ server, client, socket }));
          let client: NodeNet.Socket;
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as NodeNet.AddressInfo;
            client = NodeNet.connect(port, "127.0.0.1");
          });
        },
      ),
  ),
  ({ server, client, socket }) =>
    Effect.sync(() => {
      client.destroy();
      socket.destroy();
      server.close();
    }),
);

// The kernel's words are in host byte order.
const hex = (address: string, port: number, mapped = false) => {
  const bytes = [
    ...(mapped ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] : []),
    ...address.split(".").map(Number),
  ];
  let out = "";
  for (let index = 0; index < bytes.length; index += 4) {
    const word = bytes.slice(index, index + 4);
    const ordered = NodeOS.endianness() === "LE" ? word.toReversed() : word;
    out += ordered
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  return `${out}:${port.toString(16).toUpperCase().padStart(4, "0")}`;
};

const row = (local: string, remote: string, state: string, uid: number, inode: number) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 ${uid}        0 ${inode} 1`;

const uid = process.getuid!();

interface Table {
  readonly clientRows?: number;
  readonly uidOffset?: number;
  readonly state?: string;
  readonly inode?: number;
  readonly ownRow?: boolean;
  readonly ownState?: string;
  readonly mapped?: boolean;
  readonly ownInodeOffset?: number;
  readonly malformed?: boolean;
}

const withTable = (table: Table) =>
  Effect.gen(function* () {
    const { socket } = yield* accepted;
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-peer-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const peer = hex("127.0.0.1", socket.remotePort!, table.mapped);
    const ours = hex("127.0.0.1", socket.localPort!, table.mapped);
    const rows = [HEADER];
    for (let index = 0; index < (table.clientRows ?? 1); index++) {
      rows.push(
        row(peer, ours, table.state ?? "01", uid + (table.uidOffset ?? 0), table.inode ?? 4242),
      );
    }
    if (table.ownRow ?? true) {
      const own = socketInode(socket)! + (table.ownInodeOffset ?? 0);
      rows.push(row(ours, peer, table.ownState ?? "01", uid, own));
    }
    if (table.malformed) rows.push(row("0100007F:ZZZZ", ours, "01", uid, 1));
    const file = NodePath.join(dir, "tcp");
    NodeFS.writeFileSync(file, `${rows.join("\n")}\n`);
    return yield* isSameAccountPeer(socket, { tables: [file] });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const onLinux = HostProcess.Platform.defaultValue() === "linux";

describe("isSameAccountPeer", () => {
  // The kernel's tables exist only on Linux; the faked tables below cover the rules everywhere.
  it.effect.skipIf(!onLinux)(
    "says yes for a real loopback client of this account, from the real tables",
    () =>
      Effect.gen(function* () {
        const { socket } = yield* accepted;
        expect(yield* isSameAccountPeer(socket)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says yes when the client row and our own end are both live", () =>
    Effect.gen(function* () {
      expect(yield* withTable({})).toBe(true);
      expect(yield* withTable({ mapped: true })).toBe(true);
    }),
  );

  it.effect.each([
    ["another account owns the client", { uidOffset: 1 }],
    ["no row has the client", { clientRows: 0 }],
    ["two rows claim the client", { clientRows: 2 }],
    ["the client row is orphaned, with inode 0", { inode: 0 }],
    ["the client row is closing (FIN_WAIT2)", { state: "05" }],
    ["our own end is gone by the second read", { ownRow: false }],
    ["our own end is no longer established", { ownState: "08" }],
    ["our own row is another socket, by its inode", { ownInodeOffset: 1 }],
    ["a table holds a row that doesn't parse", { malformed: true }],
  ] as const)("says no when %s", ([, table]) =>
    Effect.gen(function* () {
      expect(yield* withTable(table)).toBe(false);
    }),
  );

  it.effect("says no when no table can be read", () =>
    Effect.gen(function* () {
      const { socket } = yield* accepted;
      expect(yield* isSameAccountPeer(socket, { tables: ["/nonexistent/tcp"] })).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the table and address formats", () => {
  it("reads a kernel row and Node's addresses to the same endpoint", () => {
    const [parsed] =
      parseTcpTable(
        `${HEADER}\n${row(hex("127.0.0.1", 8080), hex("127.0.0.1", 41234), "01", 1000, 77)}\n`,
      ) ?? [];
    expect(parsed).toEqual({
      local: { address: addressHex("127.0.0.1"), port: 8080 },
      remote: { address: addressHex("::ffff:127.0.0.1"), port: 41234 },
      state: "01",
      uid: 1000,
      inode: 77,
    });
    expect(addressHex("::1")).toBe("00000000000000000000000000000001");
    expect(
      parseTcpTable(`${HEADER}\n   0: 0100007F:1F90 0100007F:1F91 01 x x x +5 0 1\n`),
    ).toBeNull();
    expect(addressHex("not an address")).toBeNull();
  });
});
