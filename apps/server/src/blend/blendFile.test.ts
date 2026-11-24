// @effect-diagnostics nodeBuiltinImport:off - The reader is a plain async parser over node:fs streams.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { parseSdnaFieldName, readBlendFile, streamSource } from "./blendFile.ts";

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

  it("stops at its limits on total size, kept bytes and block count", async () => {
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
      await expect(readBlendFile(path, { maxScannedBytes: 1024 * 1024 })).rejects.toThrow(
        "too large",
      );
    });
    const limits = [{ maxScannedBytes: 64 * 1024 }, { maxKeptBytes: 64 * 1024 }, { maxBlocks: 50 }];
    for (const limit of limits) {
      await expect(readBlendFile(fixture("bracket-5.blend"), limit)).rejects.toThrow("too large");
    }
    // Skipping costs nothing in an uncompressed file, so only its kept bytes and blocks count.
    await withTempFile(await uncompressed("bracket-5.blend"), async (path) => {
      await expect(readBlendFile(path, { maxScannedBytes: 64 * 1024 })).resolves.toMatchObject({
        objects: 4,
      });
    });
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
      await expect(readBlendFile(path, { maxKeptBytes: 10_000 })).rejects.toThrow("too large");
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
