import {
  crc32,
  deflateRawSync,
  inflateRawSync,
  zstdCompressSync,
  zstdDecompressSync
} from "node:zlib";

export type ZipCompression = "store" | "deflate" | "zstd";

export interface ZipInputEntry {
  path: string;
  data: Uint8Array;
  compression: ZipCompression;
}

export interface ZipOutputEntry {
  path: string;
  data: Buffer;
  compression: ZipCompression;
  compressedBytes: number;
  uncompressedBytes: number;
  checksum: number;
}

export interface ZipReadLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxCompressionRatio?: number;
}

interface EncodedEntry {
  name: Buffer;
  data: Buffer;
  compressed: Buffer;
  method: number;
  checksum: number;
  localOffset: number;
  versionNeeded: number;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const METHOD_ZSTD = 93;
const DOS_DATE_1980_01_01 = 0x0021;
const MAX_U32 = 0xffffffff;

export class ZipFormatError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipFormatError";
    this.code = code;
  }
}

export function writeZip(entries: readonly ZipInputEntry[]): Buffer {
  const seen = new Set<string>();
  const encoded: EncodedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafePath(entry.path);
    if (seen.has(entry.path)) {
      throw new ZipFormatError(
        "NMD_ZIP_DUPLICATE",
        "Duplicate ZIP entry " + entry.path + "."
      );
    }
    seen.add(entry.path);

    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data);
    const method = methodFor(entry.compression);
    const compressed = compress(data, method);
    if (
      data.length > MAX_U32 ||
      compressed.length > MAX_U32 ||
      offset > MAX_U32
    ) {
      throw new ZipFormatError(
        "NMD_ZIP64_REQUIRED",
        "The 0.1 writer does not yet support ZIP64."
      );
    }
    const versionNeeded = method === METHOD_ZSTD ? 63 : 20;
    const item: EncodedEntry = {
      name,
      data,
      compressed,
      method,
      checksum: crc32(data) >>> 0,
      localOffset: offset,
      versionNeeded
    };
    encoded.push(item);
    offset += 30 + name.length + compressed.length;
  }

  const centralOffset = offset;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];

  for (const entry of encoded) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(entry.versionNeeded, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(entry.checksum, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.name, entry.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(63, 4);
    central.writeUInt16LE(entry.versionNeeded, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(entry.checksum, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(entry.localOffset, 42);
    centralParts.push(central, entry.name);
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (
    encoded.length > 0xffff ||
    centralOffset > MAX_U32 ||
    centralSize > MAX_U32
  ) {
    throw new ZipFormatError(
      "NMD_ZIP64_REQUIRED",
      "The 0.1 writer does not yet support ZIP64."
    );
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(encoded.length, 8);
  eocd.writeUInt16LE(encoded.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export function readZip(
  input: Uint8Array,
  limits: ZipReadLimits = {}
): ZipOutputEntry[] {
  const archive = Buffer.from(input);
  const maxEntries = limits.maxEntries ?? 4096;
  const maxEntryBytes = limits.maxEntryBytes ?? 512 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 1024 * 1024 * 1024;
  const maxRatio = limits.maxCompressionRatio ?? 1000;
  const eocdOffset = findEocd(archive);

  ensureRange(archive, eocdOffset, 22, "NMD_ZIP_EOCD_TRUNCATED");
  const disk = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  const commentLength = archive.readUInt16LE(eocdOffset + 20);

  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    commentLength !== 0
  ) {
    throw new ZipFormatError(
      "NMD_ZIP_FEATURE_UNSUPPORTED",
      "Multi-disk archives and ZIP comments are not supported."
    );
  }
  if (totalEntries > maxEntries) {
    throw new ZipFormatError(
      "NMD_ZIP_ENTRY_LIMIT",
      "The package contains too many entries."
    );
  }
  ensureRange(
    archive,
    centralOffset,
    centralSize,
    "NMD_ZIP_CENTRAL_TRUNCATED"
  );
  if (centralOffset + centralSize !== eocdOffset) {
    throw new ZipFormatError(
      "NMD_ZIP_LAYOUT_INVALID",
      "The central directory is not directly before the end record."
    );
  }

  const result: ZipOutputEntry[] = [];
  const seen = new Set<string>();
  let centralCursor = centralOffset;
  let totalBytes = 0;

  for (let index = 0; index < totalEntries; index++) {
    ensureRange(archive, centralCursor, 46, "NMD_ZIP_CENTRAL_TRUNCATED");
    if (archive.readUInt32LE(centralCursor) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(
        "NMD_ZIP_CENTRAL_SIGNATURE",
        "Invalid central-directory signature."
      );
    }
    const flags = archive.readUInt16LE(centralCursor + 8);
    const method = archive.readUInt16LE(centralCursor + 10);
    const checksum = archive.readUInt32LE(centralCursor + 16);
    const compressedBytes = archive.readUInt32LE(centralCursor + 20);
    const uncompressedBytes = archive.readUInt32LE(centralCursor + 24);
    const nameLength = archive.readUInt16LE(centralCursor + 28);
    const extraLength = archive.readUInt16LE(centralCursor + 30);
    const entryCommentLength = archive.readUInt16LE(centralCursor + 32);
    const localOffset = archive.readUInt32LE(centralCursor + 42);
    const centralEntryLength =
      46 + nameLength + extraLength + entryCommentLength;
    ensureRange(
      archive,
      centralCursor,
      centralEntryLength,
      "NMD_ZIP_CENTRAL_TRUNCATED"
    );
    const nameBytes = archive.subarray(
      centralCursor + 46,
      centralCursor + 46 + nameLength
    );
    const path = decodeUtf8(nameBytes);

    if (flags !== UTF8_FLAG) {
      throw new ZipFormatError(
        "NMD_ZIP_FLAGS_UNSUPPORTED",
        "ZIP entry " + path + " uses unsupported flags."
      );
    }
    assertMethod(method);
    assertSafePath(path);
    if (seen.has(path)) {
      throw new ZipFormatError(
        "NMD_ZIP_DUPLICATE",
        "Duplicate ZIP entry " + path + "."
      );
    }
    seen.add(path);
    if (uncompressedBytes > maxEntryBytes) {
      throw new ZipFormatError(
        "NMD_ZIP_ENTRY_SIZE_LIMIT",
        "ZIP entry " + path + " exceeds the configured size limit."
      );
    }
    totalBytes += uncompressedBytes;
    if (totalBytes > maxTotalBytes) {
      throw new ZipFormatError(
        "NMD_ZIP_TOTAL_SIZE_LIMIT",
        "The package exceeds the configured uncompressed-size limit."
      );
    }
    if (
      uncompressedBytes > 0 &&
      (compressedBytes === 0 || uncompressedBytes / compressedBytes > maxRatio)
    ) {
      throw new ZipFormatError(
        "NMD_ZIP_RATIO_LIMIT",
        "ZIP entry " + path + " exceeds the compression-ratio limit."
      );
    }

    const local = readLocal(
      archive,
      localOffset,
      path,
      flags,
      method,
      checksum,
      compressedBytes,
      uncompressedBytes
    );
    const data = decompress(local.compressed, method, uncompressedBytes);
    if (data.length !== uncompressedBytes) {
      throw new ZipFormatError(
        "NMD_ZIP_SIZE_MISMATCH",
        "ZIP entry " + path + " has an incorrect uncompressed size."
      );
    }
    if ((crc32(data) >>> 0) !== checksum) {
      throw new ZipFormatError(
        "NMD_ZIP_CRC_MISMATCH",
        "ZIP entry " + path + " failed its CRC-32 check."
      );
    }

    result.push({
      path,
      data,
      compression: compressionFor(method),
      compressedBytes,
      uncompressedBytes,
      checksum
    });
    centralCursor += centralEntryLength;
  }

  if (centralCursor !== centralOffset + centralSize) {
    throw new ZipFormatError(
      "NMD_ZIP_CENTRAL_SIZE_MISMATCH",
      "The central-directory size is inconsistent."
    );
  }
  return result;
}

export function assertSafePath(path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ZipFormatError(
      "NMD_ZIP_PATH_UNSAFE",
      "Unsafe package path " + JSON.stringify(path) + "."
    );
  }
  if (Buffer.from(path, "utf8").length > 0xffff) {
    throw new ZipFormatError(
      "NMD_ZIP_PATH_TOO_LONG",
      "Package path is too long."
    );
  }
}

function readLocal(
  archive: Buffer,
  offset: number,
  expectedPath: string,
  expectedFlags: number,
  expectedMethod: number,
  expectedChecksum: number,
  expectedCompressedBytes: number,
  expectedUncompressedBytes: number
): { compressed: Buffer } {
  ensureRange(archive, offset, 30, "NMD_ZIP_LOCAL_TRUNCATED");
  if (archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(
      "NMD_ZIP_LOCAL_SIGNATURE",
      "Invalid local-header signature for " + expectedPath + "."
    );
  }
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  const checksum = archive.readUInt32LE(offset + 14);
  const compressedBytes = archive.readUInt32LE(offset + 18);
  const uncompressedBytes = archive.readUInt32LE(offset + 22);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  ensureRange(
    archive,
    offset,
    30 + nameLength + extraLength + compressedBytes,
    "NMD_ZIP_LOCAL_TRUNCATED"
  );
  const path = decodeUtf8(archive.subarray(offset + 30, offset + 30 + nameLength));
  if (
    path !== expectedPath ||
    flags !== expectedFlags ||
    method !== expectedMethod ||
    checksum !== expectedChecksum ||
    compressedBytes !== expectedCompressedBytes ||
    uncompressedBytes !== expectedUncompressedBytes
  ) {
    throw new ZipFormatError(
      "NMD_ZIP_HEADER_MISMATCH",
      "Local and central headers differ for " + expectedPath + "."
    );
  }
  return {
    compressed: archive.subarray(dataOffset, dataOffset + compressedBytes)
  };
}

function compress(data: Buffer, method: number): Buffer {
  if (method === METHOD_STORE) return data;
  if (method === METHOD_DEFLATE) {
    return deflateRawSync(data, { level: 9 });
  }
  if (method === METHOD_ZSTD) return zstdCompressSync(data);
  throw new ZipFormatError(
    "NMD_ZIP_METHOD_UNSUPPORTED",
    "Unsupported compression method " + method + "."
  );
}

function decompress(
  data: Buffer,
  method: number,
  expectedBytes: number
): Buffer {
  try {
    if (method === METHOD_STORE) return data;
    if (method === METHOD_DEFLATE) {
      return inflateRawSync(data, { maxOutputLength: expectedBytes + 1 });
    }
    if (method === METHOD_ZSTD) {
      return zstdDecompressSync(data, { maxOutputLength: expectedBytes + 1 });
    }
  } catch (error) {
    throw new ZipFormatError(
      "NMD_ZIP_DECOMPRESSION_FAILED",
      "ZIP decompression failed: " +
        (error instanceof Error ? error.message : String(error))
    );
  }
  throw new ZipFormatError(
    "NMD_ZIP_METHOD_UNSUPPORTED",
    "Unsupported compression method " + method + "."
  );
}

function methodFor(compression: ZipCompression): number {
  if (compression === "store") return METHOD_STORE;
  if (compression === "deflate") return METHOD_DEFLATE;
  return METHOD_ZSTD;
}

function compressionFor(method: number): ZipCompression {
  if (method === METHOD_STORE) return "store";
  if (method === METHOD_DEFLATE) return "deflate";
  return "zstd";
}

function assertMethod(method: number): void {
  if (
    method !== METHOD_STORE &&
    method !== METHOD_DEFLATE &&
    method !== METHOD_ZSTD
  ) {
    throw new ZipFormatError(
      "NMD_ZIP_METHOD_UNSUPPORTED",
      "Unsupported ZIP compression method " + method + "."
    );
  }
}

function findEocd(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65557);
  for (let offset = archive.length - 22; offset >= minimum; offset--) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipFormatError(
    "NMD_ZIP_EOCD_MISSING",
    "The ZIP end-of-central-directory record is missing."
  );
}

function decodeUtf8(value: Buffer): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new ZipFormatError(
      "NMD_ZIP_FILENAME_UTF8",
      "A ZIP filename is not valid UTF-8."
    );
  }
  return decoded;
}

function ensureRange(
  value: Buffer,
  offset: number,
  length: number,
  code: string
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > value.length
  ) {
    throw new ZipFormatError(code, "The ZIP structure is truncated.");
  }
}
