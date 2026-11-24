// @effect-diagnostics nodeBuiltinImport:off - A plain async parser: files are read positionally, compressed ones through node:zlib.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";

import * as Schema from "effect/Schema";

/**
 * Reads what a `.blend` shows without Blender: the header, the thumbnail Blender saved, and scene
 * facts. Blocks are walked by their headers; only the few needed are kept, and DNA1 (the file's own
 * struct layouts, written last) says where fields sit in them. Format reference:
 * https://developer.blender.org/docs/features/core/blend_file/
 */
export interface BlendFileFacts {
  readonly byteLength: number;
  readonly blenderVersion: string;
  /** Rows top first, RGBA. */
  readonly thumbnail: {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
  } | null;
  readonly scene: {
    readonly name: string;
    readonly frameStart: number;
    readonly frameEnd: number;
  } | null;
  readonly scenes: number;
  readonly objects: number;
  readonly meshes: number;
  readonly materials: number;
  readonly libraries: ReadonlyArray<string>;
}

interface ByteSource {
  readonly byteLength: number;
  /** Exactly `length` bytes, or fewer where the file ends. */
  readonly read: (length: number) => Promise<Uint8Array>;
  readonly skip: (length: number) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

// Blocks this reader keeps in memory are small; the largest, DNA1, is a few hundred KB.
const MAX_KEPT_BLOCK_BYTES = 16 * 1024 * 1024;
// Blender saves 128 px thumbnails; anything much larger is not one, and would bloat the RPC.
const MAX_THUMBNAIL_SIDE = 256;
const KEPT_CODES = new Set(["TEST", "GLOB", "SC", "LI", "ID", "DNA1"]);

/** The file is not a .blend, or is damaged; any other failure is an I/O error. */
export class BlendFileFormatError extends Schema.TaggedError<BlendFileFormatError>()(
  "BlendFileFormatError",
  { problem: Schema.Literals(["not_blend", "unknown_header", "ends_early", "damaged"]) },
) {
  override get message(): string {
    switch (this.problem) {
      case "not_blend":
        return "This is not a .blend file.";
      case "unknown_header":
        return "This .blend file uses a header format this reader does not know.";
      case "ends_early":
        return "This .blend file ends early.";
      case "damaged":
        return "This .blend file is damaged.";
    }
  }
}

export const isBlendFileFormatError = Schema.is(BlendFileFormatError);

const ascii = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  return new TextDecoder("latin1").decode(end === -1 ? bytes : bytes.subarray(0, end));
};

const utf8 = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
};

async function fileSource(handle: NodeFSP.FileHandle, start: number): Promise<ByteSource> {
  const size = (await handle.stat()).size;
  let position = start;
  return {
    byteLength: size,
    read: async (length) => {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, size - position)));
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          position + offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      position += offset;
      return buffer.subarray(0, offset);
    },
    skip: async (length) => {
      position += length;
      return position <= size;
    },
    close: () => handle.close(),
  };
}

function streamSource(
  stream: NodeJS.ReadableStream & { destroy: () => void },
  byteLength: number,
): ByteSource {
  const chunks = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let pending: Uint8Array = new Uint8Array();
  let done = false;
  const fill = async () => {
    if (done) return false;
    const next = await chunks.next();
    if (next.done) {
      done = true;
      return false;
    }
    pending = pending.byteLength === 0 ? next.value : Buffer.concat([pending, next.value]);
    return true;
  };
  return {
    byteLength,
    read: async (length) => {
      while (pending.byteLength < length && (await fill())) {}
      const out = pending.subarray(0, length);
      pending = pending.subarray(out.byteLength);
      return out;
    },
    skip: async (length) => {
      let remaining = length;
      for (;;) {
        const taken = Math.min(remaining, pending.byteLength);
        pending = pending.subarray(taken);
        remaining -= taken;
        if (remaining === 0) return true;
        if (!(await fill())) return false;
      }
    },
    close: async () => stream.destroy(),
  };
}

async function openSource(filePath: string): Promise<ByteSource> {
  const handle = await NodeFSP.open(
    filePath,
    // Non-blocking keeps a FIFO from hanging the read; Windows lacks the flag.
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BlendFileFormatError({ problem: "not_blend" });
    const magic = new Uint8Array(4);
    await handle.read(magic, 0, 4, 0);
    const compression =
      magic[0] === 0x28 && magic[1] === 0xb5 && magic[2] === 0x2f && magic[3] === 0xfd
        ? NodeZlib.createZstdDecompress()
        : // Blender 2.x and 3.0 compressed with gzip.
          magic[0] === 0x1f && magic[1] === 0x8b
          ? NodeZlib.createGunzip()
          : null;
    if (compression === null) return await fileSource(handle, 0);
    const raw = handle.createReadStream({ start: 0, autoClose: true });
    raw.on("error", (cause) => compression.destroy(cause));
    const source = streamSource(raw.pipe(compression), stat.size);
    return {
      ...source,
      close: async () => {
        raw.destroy();
        await source.close();
      },
    };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

interface Header {
  readonly version: string;
  readonly pointerSize: 4 | 8;
  readonly littleEndian: boolean;
  /** Blender 5.0 and later write 64-bit block lengths. */
  readonly largeBlocks: boolean;
}

async function readHeader(source: ByteSource): Promise<Header> {
  const head = ascii(await source.read(12));
  if (!head.startsWith("BLENDER")) throw new BlendFileFormatError({ problem: "not_blend" });
  const version = (digits: string) => {
    const value = Number(digits);
    return `${Math.floor(value / 100)}.${value % 100}`;
  };
  // Before 5.0: BLENDER, `_` or `-` for 4- or 8-byte pointers, `v` or `V` for endianness, then
  // three version digits.
  if (head[7] === "_" || head[7] === "-") {
    return {
      version: version(head.slice(9, 12)),
      pointerSize: head[7] === "_" ? 4 : 8,
      littleEndian: head[8] === "v",
      largeBlocks: false,
    };
  }
  // From 5.0: BLENDER, the header size, `-`, a two-digit format version, `v`, four version digits.
  const headerSize = Number(head.slice(7, 9));
  const rest = ascii(await source.read(headerSize - 12));
  const full = head + rest;
  if (!/^BLENDER\d\d-01[vV]\d{4}$/.test(full))
    throw new BlendFileFormatError({ problem: "unknown_header" });
  return {
    version: version(full.slice(13, 17)),
    pointerSize: 8,
    littleEndian: full[12] === "v",
    largeBlocks: true,
  };
}

interface Block {
  readonly code: string;
  readonly sdnaIndex: number;
  readonly oldPointer: bigint;
  readonly data: Uint8Array;
}

interface StructField {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
}

interface Sdna {
  readonly structs: ReadonlyArray<{ readonly type: string; readonly fields: StructField[] }>;
  /** Where a nested field sits, as offset and size from the start of `structType`. */
  readonly field: (structType: string, path: ReadonlyArray<string>) => StructField | null;
}

/** Struct layouts from the DNA1 block, as they were in the Blender that saved the file. */
function parseSdna(data: Uint8Array, header: Header): Sdna {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const damaged = () => new BlendFileFormatError({ problem: "damaged" });
  const expect = (tag: string) => {
    offset = (offset + 3) & ~3;
    if (ascii(data.subarray(offset, offset + 4)) !== tag) throw damaged();
    offset += 4;
  };
  const int = () => {
    const value = view.getInt32(offset, header.littleEndian);
    offset += 4;
    return value;
  };
  const short = () => {
    const value = view.getUint16(offset, header.littleEndian);
    offset += 2;
    return value;
  };
  const strings = (count: number) =>
    Array.from({ length: count }, () => {
      const end = data.indexOf(0, offset);
      if (end === -1) throw damaged();
      const value = ascii(data.subarray(offset, end));
      offset = end + 1;
      return value;
    });
  expect("SDNA");
  expect("NAME");
  const names = strings(int());
  expect("TYPE");
  const types = strings(int());
  expect("TLEN");
  const lengths = types.map(() => short());
  expect("STRC");
  const structs = Array.from({ length: int() }, () => {
    const type = types[short()] ?? "";
    let fieldOffset = 0;
    const fields = Array.from({ length: short() }, () => {
      const fieldType = short();
      const rawName = names[short()] ?? "";
      const pointer = rawName.startsWith("*") || rawName.startsWith("(*");
      const count = [...rawName.matchAll(/\[(\d+)\]/g)].reduce(
        (product, match) => product * Number(match[1]),
        1,
      );
      const size = (pointer ? header.pointerSize : (lengths[fieldType] ?? 0)) * count;
      const field = {
        name: rawName.replace(/^[(*]+/, "").replace(/[)[].*$/, ""),
        type: types[fieldType] ?? "",
        offset: fieldOffset,
        size,
      };
      fieldOffset += size;
      return field;
    });
    return { type, fields };
  });
  const byType = new Map(structs.map((struct, index) => [struct.type, index]));
  return {
    structs,
    field: (structType, path) => {
      let type = structType;
      let found = null as StructField | null;
      for (const name of path) {
        const field = structs[byType.get(type) ?? -1]?.fields.find(
          (candidate) => candidate.name === name,
        );
        if (!field) return null;
        found = { ...field, offset: (found?.offset ?? 0) + field.offset };
        type = field.type;
      }
      return found;
    },
  };
}

async function readBlocks(source: ByteSource, header: Header) {
  const headerSize = header.largeBlocks ? 32 : header.pointerSize === 8 ? 24 : 20;
  const kept: Block[] = [];
  const counts = new Map<string, number>();
  for (;;) {
    const bytes = await source.read(headerSize);
    if (bytes.byteLength < headerSize) throw new BlendFileFormatError({ problem: "ends_early" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = header.littleEndian;
    const code = ascii(bytes.subarray(0, 4));
    if (code === "ENDB") return { kept, counts };
    // Blender 5.0's large block header puts the struct index before the pointer and the length after.
    const length = header.largeBlocks ? Number(view.getBigInt64(16, le)) : view.getInt32(4, le);
    const sdnaIndex = header.largeBlocks
      ? view.getInt32(4, le)
      : view.getInt32(4 + 4 + header.pointerSize, le);
    const oldPointer =
      header.pointerSize === 8 ? view.getBigUint64(8, le) : BigInt(view.getUint32(8, le));
    if (!Number.isSafeInteger(length) || length < 0)
      throw new BlendFileFormatError({ problem: "damaged" });
    counts.set(code, (counts.get(code) ?? 0) + 1);
    if (!KEPT_CODES.has(code)) {
      if (!(await source.skip(length))) throw new BlendFileFormatError({ problem: "ends_early" });
      continue;
    }
    if (length > MAX_KEPT_BLOCK_BYTES) throw new BlendFileFormatError({ problem: "damaged" });
    const data = await source.read(length);
    if (data.byteLength < length) throw new BlendFileFormatError({ problem: "ends_early" });
    kept.push({ code, sdnaIndex, oldPointer, data });
  }
}

function readThumbnail(block: Block | undefined, header: Header): BlendFileFacts["thumbnail"] {
  if (!block || block.data.byteLength < 8) return null;
  const view = new DataView(block.data.buffer, block.data.byteOffset, block.data.byteLength);
  const width = view.getInt32(0, header.littleEndian);
  const height = view.getInt32(4, header.littleEndian);
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_THUMBNAIL_SIDE ||
    height > MAX_THUMBNAIL_SIDE ||
    block.data.byteLength < 8 + width * height * 4
  )
    return null;
  // Blender stores image rows bottom first.
  const pixels = block.data.subarray(8, 8 + width * height * 4);
  const rgba = new Uint8Array(pixels.byteLength);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    rgba.set(pixels.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
  }
  return { width, height, rgba };
}

export async function readBlendFile(filePath: string): Promise<BlendFileFacts> {
  const source = await openSource(filePath);
  try {
    const header = await readHeader(source);
    const { kept, counts } = await readBlocks(source, header);
    const dna = kept.find((block) => block.code === "DNA1");
    if (!dna) throw new BlendFileFormatError({ problem: "damaged" });
    const sdna = parseSdna(dna.data, header);
    const typeOf = (block: Block) => sdna.structs[block.sdnaIndex]?.type ?? "";
    const view = (block: Block) =>
      new DataView(block.data.buffer, block.data.byteOffset, block.data.byteLength);
    const bytesAt = (block: Block, path: ReadonlyArray<string>) => {
      const field = sdna.field(typeOf(block), path);
      return field && field.offset + field.size <= block.data.byteLength
        ? block.data.subarray(field.offset, field.offset + field.size)
        : null;
    };
    const intAt = (block: Block, path: ReadonlyArray<string>) => {
      const field = sdna.field(typeOf(block), path);
      return field && field.size === 4 && field.offset + 4 <= block.data.byteLength
        ? view(block).getInt32(field.offset, header.littleEndian)
        : null;
    };
    const idName = (block: Block) =>
      utf8(bytesAt(block, ["id", "name"]) ?? bytesAt(block, ["name"]) ?? new Uint8Array());

    const scenes = kept.filter((block) => block.code === "SC");
    const glob = kept.find((block) => block.code === "GLOB");
    const current = glob ? bytesAt(glob, ["curscene"]) : null;
    const currentPointer =
      current === null
        ? null
        : header.pointerSize === 8
          ? new DataView(current.buffer, current.byteOffset, 8).getBigUint64(0, header.littleEndian)
          : BigInt(
              new DataView(current.buffer, current.byteOffset, 4).getUint32(0, header.littleEndian),
            );
    const sceneBlock = scenes.find((block) => block.oldPointer === currentPointer) ?? scenes[0];
    const frameStart = sceneBlock ? intAt(sceneBlock, ["r", "sfra"]) : null;
    const frameEnd = sceneBlock ? intAt(sceneBlock, ["r", "efra"]) : null;

    // A linked datablock is saved as an `ID` placeholder; its name's first two letters are its type.
    const linked = new Map<string, number>();
    for (const block of kept) {
      if (block.code !== "ID") continue;
      const code = idName(block).slice(0, 2);
      linked.set(code, (linked.get(code) ?? 0) + 1);
    }
    const count = (code: string) => (counts.get(code) ?? 0) + (linked.get(code) ?? 0);

    return {
      byteLength: source.byteLength,
      blenderVersion: header.version,
      thumbnail: readThumbnail(
        kept.find((block) => block.code === "TEST"),
        header,
      ),
      scene:
        sceneBlock && frameStart !== null && frameEnd !== null
          ? { name: idName(sceneBlock).slice(2), frameStart, frameEnd }
          : null,
      scenes: count("SC"),
      objects: count("OB"),
      meshes: count("ME"),
      materials: count("MA"),
      libraries: kept
        .filter((block) => block.code === "LI")
        .map((block) =>
          utf8(bytesAt(block, ["filepath"]) ?? bytesAt(block, ["name"]) ?? new Uint8Array()),
        )
        .filter((path) => path.length > 0),
    };
  } finally {
    await source.close();
  }
}
