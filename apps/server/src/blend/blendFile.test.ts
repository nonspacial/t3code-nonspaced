// @effect-diagnostics nodeBuiltinImport:off - The reader is a plain async parser over node:fs streams.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  fileSource,
  parseSdnaFieldName,
  readBlendFile,
  readBlendFileFacts,
  streamSource,
} from "./blendFile.ts";

// What gunzip has inflated, and a hook once it passes `abortAt` bytes.
const inflation = vi.hoisted(() => ({ produced: 0, abortAt: Infinity, onPast: () => {} }));
vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>();
  return {
    ...actual,
    createGunzip: (options?: import("node:zlib").ZlibOptions) => {
      const gunzip = actual.createGunzip(options);
      const push = gunzip.push.bind(gunzip);
      gunzip.push = (chunk: Buffer | null, encoding?: BufferEncoding) => {
        inflation.produced += chunk?.byteLength ?? 0;
        if (inflation.produced > inflation.abortAt) inflation.onPast();
        return push(chunk, encoding);
      };
      return gunzip;
    },
  };
});

// Made by fixtures/make-fixtures.sh with Blender 4.5 and 5.3; each version names its own.
const fixture = (name: string) => NodePath.join(import.meta.dirname, "fixtures", name);

async function withTempFile<A>(bytes: Uint8Array, use: (path: string) => Promise<A>): Promise<A> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-blend-"));
  try {
    const path = NodePath.join(dir, "file.blend");
    await NodeFSP.writeFile(path, bytes);
    return await use(path);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

// Blender's zstd save compresses the same stream an uncompressed save writes.
const uncompressed = async (name: string) =>
  NodeZlib.zstdDecompressSync(await NodeFSP.readFile(fixture(name)));

describe("readBlendFile", () => {
  it.each([
    { version: "5.3", file: "bracket-5.blend", header: "BLENDER17-01v0503" },
    { version: "4.5", file: "bracket-4.blend", header: "BLENDER-v405" },
  ])("reads Blender $version's header and scene facts", async ({ version, file, header }) => {
    const bytes = await uncompressed(file);
    expect(new TextDecoder().decode(bytes.subarray(0, header.length))).toBe(header);
    for (const facts of [
      await readBlendFile(fixture(file)),
      await withTempFile(bytes, readBlendFile),
    ]) {
      expect(facts).toMatchObject({
        blenderVersion: version,
        scene: { name: "Bracket", frameStart: 10, frameEnd: 120 },
        scenes: 1,
        // Two cubes, a camera and a sun.
        objects: 4,
        meshes: 2,
        materials: 2,
        libraries: [],
      });
    }
  });

  it("reads the saved thumbnail top row first, from compressed and uncompressed files", async () => {
    const compressed = await readBlendFile(fixture("bracket-5.blend"));
    const plain = await withTempFile(await uncompressed("bracket-5.blend"), readBlendFile);
    for (const facts of [compressed, plain]) {
      expect(facts.thumbnail).toMatchObject({ width: 128, height: 128 });
      expect(facts.thumbnail?.rgba.byteLength).toBe(128 * 128 * 4);
    }
    expect(plain.thumbnail?.rgba).toEqual(compressed.thumbnail?.rgba);
    const rgba = compressed.thumbnail?.rgba ?? new Uint8Array();
    const opaqueRows = Array.from({ length: 128 }, (_, row) => {
      const red: number[] = [];
      for (let x = 0; x < 128; x += 1) {
        const pixel = (row * 128 + x) * 4;
        if (rgba[pixel + 3] === 255) red.push(rgba[pixel] ?? 0);
      }
      return red.length === 0 ? null : red.reduce((sum, value) => sum + value, 0) / red.length;
    }).filter((value) => value !== null);
    // The camera looks down on a cube, so its lit top face is the first thing in the image.
    expect(opaqueRows.at(0)).toBeGreaterThan((opaqueRows.at(-1) ?? 0) + 15);
  });

  it.each([
    // Saved with thumbnails turned off.
    "parts-5.blend",
    // Blender 4.5 cannot render a thumbnail in background mode, so it saves none.
    "bracket-4.blend",
  ])("has no thumbnail when %s was saved without one", async (file) => {
    const facts = await readBlendFile(fixture(file));
    expect(facts.thumbnail).toBeNull();
  });

  it.each(["4", "5"])(
    "lists Blender %s's linked libraries and counts linked objects",
    async (v) => {
      const facts = await readBlendFile(fixture(`assembly-${v}.blend`));
      expect(facts).toMatchObject({
        scene: { name: "Assembly", frameStart: 1, frameEnd: 24 },
        libraries: [`//parts-${v}.blend`],
        // The local frame and the linked wheel; the wheel's mesh stays in its library.
        objects: 2,
        meshes: 1,
      });
    },
  );

  it("refuses files that are not .blend files, or stop partway", async () => {
    const bytes = await uncompressed("bracket-5.blend");
    await withTempFile(new TextEncoder().encode("not a blend file"), async (path) => {
      await expect(readBlendFile(path)).rejects.toThrow("not a .blend file");
    });
    await withTempFile(bytes.subarray(0, bytes.byteLength / 2), async (path) => {
      await expect(readBlendFile(path)).rejects.toThrow("ends early");
    });
    await withTempFile(
      NodeZlib.zstdCompressSync(bytes.subarray(0, bytes.byteLength / 2)),
      async (path) => {
        await expect(readBlendFile(path)).rejects.toThrow("ends early");
      },
    );
  });

  it("stops at its limits on total size, kept bytes and block count, with what it found", async () => {
    // A tiny zstd file that inflates to a 64 MB block: a decompression bomb.
    const header = new TextEncoder().encode("BLENDER-v405");
    const blockHeader = new Uint8Array(24);
    blockHeader.set(new TextEncoder().encode("DATA"));
    new DataView(blockHeader.buffer).setInt32(4, 64 * 1024 * 1024, true);
    const bomb = NodeZlib.zstdCompressSync(
      Buffer.concat([header, blockHeader, new Uint8Array(64 * 1024 * 1024)]),
    );
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await withTempFile(bomb, async (path) => {
      await expect(readBlendFile(path, { maxScannedBytes: 1024 * 1024 })).resolves.toMatchObject({
        blenderVersion: "4.5",
        partial: true,
      });
    });
    const limits = [{ maxScannedBytes: 64 * 1024 }, { maxKeptBytes: 64 * 1024 }, { maxBlocks: 50 }];
    for (const limit of limits) {
      // Stopped before its size once inflated is known, a compressed file may be a large one.
      await expect(readBlendFile(fixture("bracket-5.blend"), limit)).resolves.toMatchObject({
        objects: 0,
        partial: true,
        large: true,
        sizeUnknown: true,
      });
    }
    // Skipping costs nothing in an uncompressed file, so only its kept bytes and blocks count.
    await withTempFile(await uncompressed("bracket-5.blend"), async (path) => {
      await expect(readBlendFile(path, { maxScannedBytes: 64 * 1024 })).resolves.toMatchObject({
        objects: 4,
      });
      // Its size on disk is its size: a small one stopped at a limit is still small.
      const stopped = await readBlendFile(path, { maxKeptBytes: 64 * 1024 });
      expect(stopped).toMatchObject({ partial: true });
      expect(stopped).not.toHaveProperty("large");
    });
  });

  it("reads a file past its whole-file limit only as far as its thumbnail", async () => {
    for (const facts of [
      await readBlendFile(fixture("bracket-5.blend"), { wholeUpTo: 0 }),
      await withTempFile(await uncompressed("bracket-5.blend"), (path) =>
        readBlendFile(path, { wholeUpTo: 0 }),
      ),
    ]) {
      expect(facts).toMatchObject({
        blenderVersion: "5.3",
        thumbnail: { width: 128, height: 128 },
        scene: null,
        objects: 0,
        partial: true,
      });
    }
  });

  it("refuses struct layouts whose counts or indices do not fit the block", async () => {
    const bytes = await uncompressed("bracket-5.blend");
    const at = (tag: string) => Buffer.from(bytes).indexOf(tag);
    const corrupt = async (edit: (copy: Buffer) => void) => {
      const copy = Buffer.from(bytes);
      edit(copy);
      await withTempFile(copy, async (path) => {
        await expect(readBlendFile(path)).rejects.toThrow("damaged");
      });
    };
    // A name count far past the block's end.
    await corrupt((copy) => copy.writeInt32LE(0x7fffffff, at("SDNANAME") + 8));
    // The first struct naming a type that does not exist.
    await corrupt((copy) => copy.writeUInt16LE(0xffff, at("STRC") + 8));
    // The first struct with fields declared 1 byte long, so they run past its end.
    await corrupt((copy) => {
      let struct = at("STRC") + 8;
      while (copy.readUInt16LE(struct + 2) === 0) struct += 4;
      copy.writeUInt16LE(1, at("TLEN") + 4 + copy.readUInt16LE(struct) * 2);
    });
    // Real layouts have some tens of thousands of entries; a cap below that refuses this one.
    await expect(
      readBlendFile(fixture("bracket-5.blend"), { maxSdnaEntries: 1000 }),
    ).rejects.toThrow("too large");
  });

  it("charges each kept block a fixed cost, so millions of empty ones cannot pile up", async () => {
    const header = new TextEncoder().encode("BLENDER-v405");
    const empty = new Uint8Array(24);
    empty.set(new TextEncoder().encode("ID"));
    const end = new Uint8Array(24);
    end.set(new TextEncoder().encode("ENDB"));
    const bytes = Buffer.concat([header, ...Array.from({ length: 1000 }, () => empty), end]);
    await withTempFile(bytes, async (path) => {
      await expect(readBlendFile(path, { maxKeptBytes: 10_000 })).resolves.toMatchObject({
        partial: true,
      });
    });
  });

  it("copies what it keeps out of a compressed stream, so the rest of a chunk can be freed", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const source = streamSource(NodeStream.Readable.from([chunk]), chunk.byteLength);
    const kept = await source.read(100);
    expect(kept.buffer.byteLength).toBe(100);
    await source.close();
  });

  it("parses a struct field's name, and refuses an oversized one", () => {
    expect(parseSdnaFieldName("*next")).toEqual({ name: "next", pointer: true, items: 1 });
    expect(parseSdnaFieldName("(*func)()")).toEqual({ name: "func", pointer: true, items: 1 });
    expect(parseSdnaFieldName("mat[4][4]")).toEqual({ name: "mat", pointer: false, items: 16 });
    for (const name of [
      "x".repeat(300),
      `a${"[1]".repeat(200)}`,
      "a[99999][99999][99999][99999]",
      "a[]",
      "a[1e2]",
    ]) {
      expect(() => parseSdnaFieldName(name)).toThrow("damaged");
    }
  });
});

describe("P1: reading a large .blend", () => {
  // An uncompressed header, then `blocks` empty DATA blocks with 8-byte pointers, and no end.
  const manyBlocks = (blocks: number) => {
    const bytes = new Uint8Array(12 + blocks * 24);
    bytes.set(new TextEncoder().encode("BLENDER-v405"));
    for (let block = 0; block < blocks; block += 1) {
      bytes.set(new TextEncoder().encode("DATA"), 12 + block * 24);
    }
    return bytes;
  };

  it("walks a million block headers in a few disk reads, not one each", async () => {
    const bytes = manyBlocks(1_000_000);
    let reads = 0;
    const source = await fileSource(
      {
        stat: async () => ({ size: bytes.byteLength }),
        read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          reads += 1;
          const chunk = bytes.subarray(position, position + length);
          buffer.set(chunk, offset);
          return { bytesRead: chunk.byteLength, buffer };
        },
        close: async () => undefined,
      } as never,
      12,
    );
    for (let block = 0; block < 1_000_000; block += 1) {
      const header = await source.read(16);
      if (header[0] !== 0x44) throw new Error(`block ${block} misread`);
      await source.skip(8);
    }
    // 24 MB through a 1 MiB window.
    expect(reads).toBeLessThanOrEqual(Math.ceil(bytes.byteLength / (1024 * 1024)) + 1);
  });

  it("stops a walk when its reader gives up", async () => {
    const controller = new AbortController();
    const reading = withTempFile(manyBlocks(500_000), (path) =>
      readBlendFile(path, {}, controller.signal),
    );
    setImmediate(() => controller.abort());
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("N4: an abort stops a compressed skip at once, not once the skip is done", async () => {
    // One 512 MiB block of zeros, which gzip packs into well under a megabyte, for the walk to skip.
    const blockBytes = 512 * 1024 * 1024;
    const head = new Uint8Array(12 + 24);
    head.set(new TextEncoder().encode("BLENDER-v405"));
    head.set(new TextEncoder().encode("DATA"), 12);
    new DataView(head.buffer).setInt32(16, blockBytes, true);
    const zeros = Buffer.alloc(16 * 1024 * 1024);
    const compressed = Buffer.concat(
      await NodeStream.Readable.from(
        (function* () {
          yield Buffer.from(head);
          for (let sent = 0; sent < blockBytes; sent += zeros.byteLength) yield zeros;
        })(),
      )
        .pipe(NodeZlib.createGzip({ level: 1 }))
        .toArray(),
    );
    const controller = new AbortController();
    inflation.produced = 0;
    inflation.abortAt = 32 * 1024 * 1024;
    inflation.onPast = () => controller.abort();
    try {
      // A conversion's read, which walks a compressed file past the large-file size.
      await withTempFile(compressed, (path) =>
        expect(
          readBlendFile(path, { wholeUpTo: Infinity }, controller.signal),
        ).rejects.toMatchObject({
          name: "AbortError",
        }),
      );
      expect(inflation.produced).toBeLessThan(128 * 1024 * 1024);
    } finally {
      inflation.abortAt = Infinity;
    }
  });

  it("never inflates a compressed file past what its read may walk", async () => {
    // Header, then one 64 MiB block of zeros that gzip packs small.
    const head = new Uint8Array(12 + 24);
    head.set(new TextEncoder().encode("BLENDER-v405"));
    head.set(new TextEncoder().encode("DATA"), 12);
    new DataView(head.buffer).setInt32(16, 64 * 1024 * 1024, true);
    const compressed = NodeZlib.gzipSync(Buffer.concat([head, new Uint8Array(64 * 1024 * 1024)]), {
      level: 1,
    });
    await withTempFile(compressed, async (path) => {
      // A large file's thumbnail read, whose block would end past its budget.
      inflation.produced = 0;
      await expect(readBlendFile(path, { wholeUpTo: 0 })).resolves.toMatchObject({ partial: true });
      expect(inflation.produced).toBeLessThan(4 * 1024 * 1024);
      // A small file that inflates past the large-file size is read as a large one.
      inflation.produced = 0;
      await expect(readBlendFile(path, { wholeUpTo: 1024 * 1024 })).resolves.toMatchObject({
        partial: true,
      });
      expect(inflation.produced).toBeLessThan(4 * 1024 * 1024);
    });
  });

  it("keeps a compressed file that inflates past the large-file size large after a whole read", async () => {
    // Blender 4.5's scene with a 513 MiB block of zeros after its header, which gzip packs small.
    const scene = await uncompressed("bracket-4.blend");
    const blockBytes = 513 * 1024 * 1024;
    const block = new Uint8Array(24);
    block.set(new TextEncoder().encode("DATA"));
    new DataView(block.buffer).setInt32(4, blockBytes, true);
    const zeros = Buffer.alloc(16 * 1024 * 1024);
    const compressed = Buffer.concat(
      await NodeStream.Readable.from(
        (function* () {
          yield Buffer.from(scene.subarray(0, 12));
          yield Buffer.from(block);
          for (let sent = 0; sent < blockBytes; sent += zeros.byteLength) yield zeros;
          yield Buffer.from(scene.subarray(12));
        })(),
      )
        .pipe(NodeZlib.createGzip({ level: 1 }))
        .toArray(),
    );
    await withTempFile(compressed, async (path) => {
      expect(await readBlendFileFacts(path, "revision-1")).toMatchObject({ large: true });
      // A conversion reads it whole; the next preview of that revision still asks first.
      expect(await readBlendFileFacts(path, "revision-1", undefined, true)).toMatchObject({
        large: true,
        objects: 4,
      });
      expect(await readBlendFileFacts(path, "revision-1")).toMatchObject({ large: true });
      // A whole read that stops at a limit after the large-file size is still a large file's.
      const pastLarge = 24 + blockBytes;
      await expect(
        readBlendFile(path, { wholeUpTo: Infinity, maxBlocks: 2 }),
      ).resolves.toMatchObject({ partial: true, large: true });
      await expect(
        readBlendFile(path, { wholeUpTo: Infinity, maxScannedBytes: pastLarge }),
      ).resolves.toMatchObject({ partial: true, large: true });
      // Once a revision is found large, no later read of it clears that.
      expect(await readBlendFileFacts(path, "revision-2")).toMatchObject({ large: true });
      await NodeFSP.writeFile(path, scene);
      expect(await readBlendFileFacts(path, "revision-2", undefined, true)).toMatchObject({
        large: true,
      });
      expect(await readBlendFileFacts(path, "revision-2")).toMatchObject({ large: true });
    });
  });

  it("walks a file once while its revision stays the same, whichever read asked", async () => {
    await withTempFile(await NodeFSP.readFile(fixture("bracket-5.blend")), async (path) => {
      const first = await readBlendFileFacts(path, "revision-1");
      // Whatever is on disk now, the same revision answers from what was read.
      await NodeFSP.writeFile(path, "not a blend file");
      expect(await readBlendFileFacts(path, "revision-1")).toBe(first);
      // A conversion's whole read of a file under the large-file size is the preview's walk.
      expect(await readBlendFileFacts(path, "revision-1", undefined, true)).toBe(first);
      await expect(readBlendFileFacts(path, "revision-2")).rejects.toMatchObject({
        problem: "not_blend",
      });
    });
  });
});
