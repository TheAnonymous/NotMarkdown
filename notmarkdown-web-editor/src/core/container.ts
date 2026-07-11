import { compress, decompress, init } from "@bokuweb/zstd-wasm";
import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { deflateSync, inflateSync } from "fflate";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import type { DocumentNode } from "@notmarkdown/reference-toolchain";

export type ContainerProfile = "modern-0.1" | "portable-0.1";
export type Compression = "store" | "deflate" | "zstd";

export interface AssetData {
  id: string;
  fileName: string;
  mediaType: string;
  fingerprint: string;
  kind: "image" | "audio" | "video" | "diagram" | "data" | "attachment";
  role:
    | "playback"
    | "original"
    | "fallback"
    | "poster"
    | "thumbnail"
    | "waveform"
    | "captions"
    | "transcript"
    | "chapters"
    | "source"
    | "data";
  bytes: number;
  data?: Uint8Array;
  load?: () => Promise<Uint8Array>;
  openStream?: () => ReadableStream<Uint8Array>;
}

export interface ManifestRepresentation {
  path: string;
  mediaType: string;
  role: AssetData["role"];
  bytes: number;
  sha256: string;
}

export interface ManifestAsset {
  kind: AssetData["kind"];
  representations: ManifestRepresentation[];
}

export interface PackageManifest {
  format: "notmarkdown";
  packageVersion: "0.1";
  source: "document.nmt";
  sourceSha256: string;
  containerProfile: ContainerProfile;
  themeProfile: "0.1";
  mediaProfile: string;
  assets: Record<string, ManifestAsset>;
}

export interface PackageEntry {
  path: string;
  data?: Uint8Array;
  compression: Compression;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface RangeReadTelemetry {
  archiveBytes: number;
  bytesRead: number;
  rangeReads: number;
  entriesLoaded: number;
}

export interface OpenedBrowserPackage {
  source: string;
  document: DocumentNode;
  manifest: PackageManifest;
  assets: AssetData[];
  entries: PackageEntry[];
  rangeTelemetry?: RangeReadTelemetry;
}

export interface ByteRangeSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface WriteEntry {
  path: string;
  data: Uint8Array;
  compression: Compression;
}

export interface BrowserPackageSink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface PackageWriteTelemetry {
  outputBytes: number;
  sourceAssetBytesRead: number;
  entriesWritten: number;
  peakBufferedEntryBytes: number;
}

interface PreparedAsset {
  asset: AssetData;
  path: string;
  bytes: number;
  checksum: number;
  sha256: string;
  compression: Compression;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MIMETYPE = "application/vnd.notmarkdown.document+zip";
const UTF8_FLAG = 0x0800;
const DOS_DATE = 0x0021;
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const MAX_EOCD_BYTES = 65_557;
const MAX_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 ** 3;
const MAX_COMPRESSION_RATIO = 1000;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ZIP32_BYTES = 0xffff_ffff;
const compressible = new Set([
  "application/json",
  "application/xml",
  "image/svg+xml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/vtt"
]);
let zstdInitialization: Promise<void> | undefined;

export async function createBrowserPackage(options: {
  source: string;
  assets: readonly AssetData[];
  profile: ContainerProfile;
  mediaProfile?: string;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await writeBrowserPackageToSink(options, {
    async write(data) {
      chunks.push(data.slice());
    },
    async close() {},
    async abort() {
      chunks.length = 0;
    }
  });
  return concat(chunks);
}

/**
 * Writes a deterministic ZIP32 package incrementally. Stored media streams
 * directly to the sink; only the currently compressed entry is buffered.
 * All assets are scanned and verified before the first output byte is written.
 */
export async function writeBrowserPackageToSink(
  options: {
    source: string;
    assets: readonly AssetData[];
    profile: ContainerProfile;
    mediaProfile?: string;
  },
  sink: BrowserPackageSink
): Promise<PackageWriteTelemetry> {
  const telemetry: PackageWriteTelemetry = {
    outputBytes: 0,
    sourceAssetBytesRead: 0,
    entriesWritten: 0,
    peakBufferedEntryBytes: 0
  };
  try {
    const source = normalizeSource(options.source);
    const parsed = parse(source);
    if (!parsed.document) {
      throw new Error(
        parsed.diagnostics[0]?.code + ": " + parsed.diagnostics[0]?.message
      );
    }
    const referenced = collectAssetIds(parsed.document);
    const assets = [...options.assets].sort(compareAssetIds);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    for (const id of referenced) {
      if (!byId.has(id)) throw new Error("Missing asset " + id + ".");
    }
    for (const asset of assets) {
      if (!referenced.has(asset.id)) {
        throw new Error("Asset " + asset.id + " is not referenced.");
      }
    }

    const prepared: PreparedAsset[] = [];
    const manifestAssets: Record<string, ManifestAsset> = {};
    for (const asset of assets) {
      const integrity = await scanAsset(asset);
      telemetry.sourceAssetBytesRead += integrity.bytes;
      if (telemetry.sourceAssetBytesRead > MAX_EXPANDED_BYTES) {
        throw new Error("Package resource limit exceeded.");
      }
      const path =
        "assets/" + asset.id + safeExtension(asset.fileName, asset.mediaType);
      safePath(path);
      const item: PreparedAsset = {
        asset,
        path,
        bytes: integrity.bytes,
        checksum: integrity.checksum,
        sha256: integrity.sha256,
        compression: compressionFor(options.profile, asset.mediaType)
      };
      prepared.push(item);
      manifestAssets[asset.id] = {
        kind: asset.kind,
        representations: [
          {
            path,
            mediaType: asset.mediaType,
            role: asset.role,
            bytes: integrity.bytes,
            sha256: integrity.sha256
          }
        ]
      };
    }

    const sourceBytes = encoder.encode(source);
    const manifest: PackageManifest = {
      format: "notmarkdown",
      packageVersion: "0.1",
      source: "document.nmt",
      sourceSha256: await sha256(sourceBytes),
      containerProfile: options.profile,
      themeProfile: "0.1",
      mediaProfile: options.mediaProfile ?? "2026-draft",
      assets: manifestAssets
    };
    const textCompression: Compression =
      options.profile === "modern-0.1" ? "zstd" : "deflate";
    const writer = new StreamingZipWriter(sink, telemetry);
    await writer.writeBuffered(
      "mimetype",
      encoder.encode(MIMETYPE),
      "store"
    );
    await writer.writeBuffered(
      "manifest.json",
      encoder.encode(stableJson(manifest) + "\n"),
      textCompression
    );
    await writer.writeBuffered("document.nmt", sourceBytes, textCompression);
    for (const item of prepared) {
      if (item.compression === "store") {
        await writer.writeStoredAsset(item);
        telemetry.sourceAssetBytesRead += item.bytes;
      } else {
        const data = await collectAsset(item.asset);
        verifyPreparedAsset(item, data);
        telemetry.sourceAssetBytesRead += data.length;
        telemetry.peakBufferedEntryBytes = Math.max(
          telemetry.peakBufferedEntryBytes,
          data.length
        );
        await writer.writeBuffered(item.path, data, item.compression);
      }
    }
    await writer.finish();
    await sink.close();
    return telemetry;
  } catch (error) {
    try {
      await sink.abort(error);
    } catch {
      // Preserve the package error rather than masking it with cleanup failure.
    }
    throw error;
  }
}

interface StreamedCentralEntry {
  name: Uint8Array;
  method: number;
  version: number;
  checksum: number;
  packedBytes: number;
  bytes: number;
  offset: number;
}

class StreamingZipWriter {
  private offset = 0;
  private readonly entries: StreamedCentralEntry[] = [];

  constructor(
    private readonly sink: BrowserPackageSink,
    private readonly telemetry: PackageWriteTelemetry
  ) {}

  async writeBuffered(
    path: string,
    data: Uint8Array,
    compression: Compression
  ): Promise<void> {
    safePath(path);
    const packed = await compressBytes(data, compression);
    this.telemetry.peakBufferedEntryBytes = Math.max(
      this.telemetry.peakBufferedEntryBytes,
      data.length + (packed === data ? 0 : packed.length)
    );
    const entry = this.beginEntry(
      path,
      compression,
      crc32(data),
      packed.length,
      data.length
    );
    await this.emit(localHeader(entry));
    await this.emit(entry.name);
    await this.emit(packed);
    this.entries.push(entry);
    this.telemetry.entriesWritten++;
  }

  async writeStoredAsset(item: PreparedAsset): Promise<void> {
    const entry = this.beginEntry(
      item.path,
      "store",
      item.checksum,
      item.bytes,
      item.bytes
    );
    await this.emit(localHeader(entry));
    await this.emit(entry.name);

    const hash = incrementalSha256.create();
    let checksum = 0xffffffff;
    let bytes = 0;
    for await (const chunk of assetChunks(item.asset)) {
      bytes += chunk.length;
      if (bytes > item.bytes) {
        throw new Error("Asset " + item.asset.id + " changed while saving.");
      }
      checksum = crc32Update(checksum, chunk);
      hash.update(chunk);
      await this.emit(chunk);
    }
    const actualChecksum = (checksum ^ 0xffffffff) >>> 0;
    const actualHash = hex(hash.digest());
    if (
      bytes !== item.bytes ||
      actualChecksum !== item.checksum ||
      actualHash !== item.sha256
    ) {
      throw new Error("Asset " + item.asset.id + " changed while saving.");
    }
    this.entries.push(entry);
    this.telemetry.entriesWritten++;
  }

  async finish(): Promise<void> {
    const centralOffset = this.offset;
    const central = concat(this.entries.flatMap((entry) => centralRecord(entry)));
    if (central.length > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error("Central directory exceeds its resource limit.");
    }
    await this.emit(central);
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    u32(view, 0, EOCD);
    u16(view, 8, this.entries.length);
    u16(view, 10, this.entries.length);
    u32(view, 12, central.length);
    u32(view, 16, centralOffset);
    await this.emit(eocd);
  }

  private beginEntry(
    path: string,
    compression: Compression,
    checksum: number,
    packedBytes: number,
    bytes: number
  ): StreamedCentralEntry {
    if (this.entries.some((entry) => decode(entry.name) === path)) {
      throw new Error("Duplicate entry " + path + ".");
    }
    if (
      packedBytes > MAX_ZIP32_BYTES ||
      bytes > MAX_ENTRY_BYTES ||
      this.offset > MAX_ZIP32_BYTES
    ) {
      throw new Error("ZIP32 package limit exceeded.");
    }
    const method = compressionMethod(compression);
    return {
      name: encoder.encode(path),
      method,
      version: method === 93 ? 63 : 20,
      checksum,
      packedBytes,
      bytes,
      offset: this.offset
    };
  }

  private async emit(data: Uint8Array): Promise<void> {
    if (this.offset + data.length > MAX_ZIP32_BYTES) {
      throw new Error("ZIP32 package limit exceeded.");
    }
    await this.sink.write(data);
    this.offset += data.length;
    this.telemetry.outputBytes = this.offset;
  }
}

function localHeader(entry: StreamedCentralEntry): Uint8Array {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  u32(view, 0, LOCAL);
  u16(view, 4, entry.version);
  u16(view, 6, UTF8_FLAG);
  u16(view, 8, entry.method);
  u16(view, 12, DOS_DATE);
  u32(view, 14, entry.checksum);
  u32(view, 18, entry.packedBytes);
  u32(view, 22, entry.bytes);
  u16(view, 26, entry.name.length);
  return header;
}

function centralRecord(entry: StreamedCentralEntry): Uint8Array[] {
  const record = new Uint8Array(46);
  const view = new DataView(record.buffer);
  u32(view, 0, CENTRAL);
  u16(view, 4, 63);
  u16(view, 6, entry.version);
  u16(view, 8, UTF8_FLAG);
  u16(view, 10, entry.method);
  u16(view, 14, DOS_DATE);
  u32(view, 16, entry.checksum);
  u32(view, 20, entry.packedBytes);
  u32(view, 24, entry.bytes);
  u16(view, 28, entry.name.length);
  u32(view, 42, entry.offset);
  return [record, entry.name];
}

function compressionMethod(compression: Compression): number {
  return compression === "store" ? 0 : compression === "deflate" ? 8 : 93;
}

async function scanAsset(asset: AssetData): Promise<{
  bytes: number;
  checksum: number;
  sha256: string;
}> {
  const hash = incrementalSha256.create();
  let checksum = 0xffffffff;
  let bytes = 0;
  for await (const chunk of assetChunks(asset)) {
    bytes += chunk.length;
    if (bytes > MAX_ENTRY_BYTES) {
      throw new Error("Asset " + asset.id + " exceeds the size limit.");
    }
    checksum = crc32Update(checksum, chunk);
    hash.update(chunk);
  }
  if (bytes !== asset.bytes) {
    throw new Error("Asset " + asset.id + " failed its size check.");
  }
  return {
    bytes,
    checksum: (checksum ^ 0xffffffff) >>> 0,
    sha256: hex(hash.digest())
  };
}

async function* assetChunks(asset: AssetData): AsyncGenerator<Uint8Array> {
  if (asset.data) {
    yield asset.data;
    return;
  }
  if (asset.openStream) {
    const reader = asset.openStream().getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        if (next.value.length) yield next.value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  const data = await asset.load?.();
  if (!data) throw new Error("Asset " + asset.id + " has no readable data.");
  yield data;
}

async function collectAsset(asset: AssetData): Promise<Uint8Array> {
  if (asset.data) return asset.data;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of assetChunks(asset)) {
    bytes += chunk.length;
    if (bytes > MAX_ENTRY_BYTES) {
      throw new Error("Asset " + asset.id + " exceeds the size limit.");
    }
    chunks.push(chunk.slice());
  }
  return concat(chunks);
}

function verifyPreparedAsset(item: PreparedAsset, data: Uint8Array): void {
  if (
    data.length !== item.bytes ||
    crc32(data) !== item.checksum ||
    hex(incrementalSha256(data)) !== item.sha256
  ) {
    throw new Error("Asset " + item.asset.id + " changed while saving.");
  }
}

function compareAssetIds(left: AssetData, right: AssetData): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export async function openBrowserPackage(
  input: Uint8Array
): Promise<OpenedBrowserPackage> {
  const entries = await readZip(input);
  if (entries[0]?.path !== "mimetype") {
    throw new Error("The mimetype entry must be first.");
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const mimetype = byPath.get("mimetype");
  if (
    !mimetype ||
    mimetype.compression !== "store" ||
    decode(eagerData(mimetype)) !== MIMETYPE
  ) {
    throw new Error("Invalid NotMarkdown mimetype entry.");
  }
  const manifestEntry = required(byPath, "manifest.json");
  const sourceEntry = required(byPath, "document.nmt");
  const manifest = parseManifest(decode(eagerData(manifestEntry)));
  validateCompressionProfile(entries, manifest);
  const sourceBytes = eagerData(sourceEntry);
  const source = decode(sourceBytes);
  if ((await sha256(sourceBytes)) !== manifest.sourceSha256) {
    throw new Error("The document source failed its SHA-256 check.");
  }
  const parsed = parse(source);
  if (!parsed.document) {
    throw new Error(
      parsed.diagnostics[0]?.code + ": " + parsed.diagnostics[0]?.message
    );
  }

  const assets: AssetData[] = [];
  const declared = new Set(["mimetype", "manifest.json", "document.nmt"]);
  for (const [id, asset] of Object.entries(manifest.assets)) {
    const representation = asset.representations[0];
    if (!representation) throw new Error("Asset " + id + " has no data.");
    declared.add(representation.path);
    const entry = required(byPath, representation.path);
    const data = eagerData(entry);
    if (
      data.length !== representation.bytes ||
      (await sha256(data)) !== representation.sha256
    ) {
      throw new Error("Asset " + id + " failed its integrity check.");
    }
    assets.push({
      id,
      fileName: representation.path.split("/").at(-1) ?? id,
      mediaType: representation.mediaType,
      fingerprint: representation.sha256,
      kind: asset.kind,
      role: representation.role,
      bytes: data.length,
      data
    });
  }
  for (const entry of entries) {
    if (!declared.has(entry.path)) {
      throw new Error("Undeclared package entry " + entry.path + ".");
    }
  }

  return {
    source,
    document: parsed.document,
    manifest,
    assets,
    entries
  };
}

interface RangedZipEntry extends PackageEntry {
  checksum: number;
  dataOffset: number;
}

interface RangedZipDirectory {
  entries: RangedZipEntry[];
  readEntry(entry: RangedZipEntry): Promise<Uint8Array>;
  streamEntry(entry: RangedZipEntry): ReadableStream<Uint8Array>;
}

/**
 * Opens a Blob-backed package without reading the entire archive. Only the ZIP
 * tail, directory, local headers, manifest, and source are read initially.
 * Asset loaders verify CRC-32 and manifest SHA-256 before exposing bytes.
 */
export async function openBrowserPackageFromBlob(
  input: Blob
): Promise<OpenedBrowserPackage> {
  const telemetry: RangeReadTelemetry = {
    archiveBytes: input.size,
    bytesRead: 0,
    rangeReads: 0,
    entriesLoaded: 0
  };
  const source: ByteRangeSource = {
    size: input.size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > input.size) {
        throw new Error("Invalid package byte range.");
      }
      return new Uint8Array(await input.slice(offset, offset + length).arrayBuffer());
    }
  };
  return openBrowserPackageFromRangeSource(source, telemetry);
}

export async function openBrowserPackageFromRangeSource(
  source: ByteRangeSource,
  telemetry: RangeReadTelemetry = {
    archiveBytes: source.size,
    bytesRead: 0,
    rangeReads: 0,
    entriesLoaded: 0
  }
): Promise<OpenedBrowserPackage> {
  telemetry.archiveBytes = source.size;
  telemetry.bytesRead = 0;
  telemetry.rangeReads = 0;
  telemetry.entriesLoaded = 0;
  const ranges: Array<[number, number]> = [];
  const measured: ByteRangeSource = {
    size: source.size,
    async read(offset, length) {
      const data = await source.read(offset, length);
      if (data.length !== length) throw new Error("Truncated package range.");
      telemetry.rangeReads++;
      recordRange(ranges, offset, offset + length);
      telemetry.bytesRead = ranges.reduce(
        (total, [start, end]) => total + end - start,
        0
      );
      return data;
    }
  };
  const directory = await readZipDirectory(measured, telemetry);
  if (directory.entries[0]?.path !== "mimetype") {
    throw new Error("The mimetype entry must be first.");
  }
  const byPath = new Map(directory.entries.map((entry) => [entry.path, entry]));
  const mimetypeEntry = requiredRanged(byPath, "mimetype");
  if (mimetypeEntry.compression !== "store") {
    throw new Error("Invalid NotMarkdown mimetype entry.");
  }
  const mimetype = await directory.readEntry(mimetypeEntry);
  if (decode(mimetype) !== MIMETYPE) {
    throw new Error("Invalid NotMarkdown mimetype entry.");
  }

  const manifestEntry = requiredRanged(byPath, "manifest.json");
  const sourceEntry = requiredRanged(byPath, "document.nmt");
  const manifest = parseManifest(decode(await directory.readEntry(manifestEntry)));
  validateCompressionProfile(directory.entries, manifest);
  const sourceBytes = await directory.readEntry(sourceEntry);
  const documentSource = decode(sourceBytes);
  if ((await sha256(sourceBytes)) !== manifest.sourceSha256) {
    throw new Error("The document source failed its SHA-256 check.");
  }
  const parsed = parse(documentSource);
  if (!parsed.document) {
    throw new Error(
      parsed.diagnostics[0]?.code + ": " + parsed.diagnostics[0]?.message
    );
  }

  const assets: AssetData[] = [];
  const declared = new Set(["mimetype", "manifest.json", "document.nmt"]);
  for (const [id, asset] of Object.entries(manifest.assets)) {
    const representation = asset.representations[0];
    if (!representation) throw new Error("Asset " + id + " has no data.");
    declared.add(representation.path);
    const entry = requiredRanged(byPath, representation.path);
    if (entry.uncompressedBytes !== representation.bytes) {
      throw new Error("Asset " + id + " failed its size check.");
    }
    let loaded: Promise<Uint8Array> | undefined;
    const load = () => {
      loaded ??= (async () => {
        const data = await directory.readEntry(entry);
        if ((await sha256(data)) !== representation.sha256) {
          throw new Error("Asset " + id + " failed its SHA-256 check.");
        }
        return data;
      })();
      return loaded;
    };
    assets.push({
      id,
      fileName: representation.path.split("/").at(-1) ?? id,
      mediaType: representation.mediaType,
      fingerprint: representation.sha256,
      kind: asset.kind,
      role: representation.role,
      bytes: representation.bytes,
      load,
      openStream: () => directory.streamEntry(entry)
    });
  }
  for (const entry of directory.entries) {
    if (!declared.has(entry.path)) {
      throw new Error("Undeclared package entry " + entry.path + ".");
    }
  }

  return {
    source: documentSource,
    document: parsed.document,
    manifest,
    assets,
    entries: directory.entries,
    rangeTelemetry: telemetry
  };
}

async function readZipDirectory(
  source: ByteRangeSource,
  telemetry: RangeReadTelemetry
): Promise<RangedZipDirectory> {
  if (source.size < 22) throw new Error("Missing ZIP end record.");
  const tailLength = Math.min(source.size, MAX_EOCD_BYTES);
  const tailOffset = source.size - tailLength;
  const tail = await source.read(tailOffset, tailLength);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const eocdInTail = findEocd(tailView);
  const eocd = tailOffset + eocdInTail;
  ensure(tailView, eocdInTail, 22);
  const disk = tailView.getUint16(eocdInTail + 4, true);
  const centralDisk = tailView.getUint16(eocdInTail + 6, true);
  const diskCount = tailView.getUint16(eocdInTail + 8, true);
  const count = tailView.getUint16(eocdInTail + 10, true);
  const centralSize = tailView.getUint32(eocdInTail + 12, true);
  const centralOffset = tailView.getUint32(eocdInTail + 16, true);
  const commentLength = tailView.getUint16(eocdInTail + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskCount !== count ||
    commentLength !== 0 ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("Unsupported multi-disk or ZIP64 package.");
  }
  if (eocdInTail + 22 + commentLength !== tail.length) {
    throw new Error("Invalid ZIP end record.");
  }
  if (
    count > MAX_ENTRIES ||
    centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
    centralOffset + centralSize !== eocd
  ) {
    throw new Error("Invalid or oversized central directory.");
  }

  const central = await source.read(centralOffset, centralSize);
  const centralView = new DataView(
    central.buffer,
    central.byteOffset,
    central.byteLength
  );
  const entries: RangedZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    ensure(centralView, cursor, 46);
    if (centralView.getUint32(cursor, true) !== CENTRAL) {
      throw new Error("Invalid central-directory signature.");
    }
    const flags = centralView.getUint16(cursor + 8, true);
    const method = centralView.getUint16(cursor + 10, true);
    const checksum = centralView.getUint32(cursor + 16, true);
    const packedSize = centralView.getUint32(cursor + 20, true);
    const size = centralView.getUint32(cursor + 24, true);
    const nameLength = centralView.getUint16(cursor + 28, true);
    const extraLength = centralView.getUint16(cursor + 30, true);
    const entryCommentLength = centralView.getUint16(cursor + 32, true);
    const localOffset = centralView.getUint32(cursor + 42, true);
    ensure(
      centralView,
      cursor,
      46 + nameLength + extraLength + entryCommentLength
    );
    const path = decode(
      central.subarray(cursor + 46, cursor + 46 + nameLength)
    );
    if (extraLength !== 0 || entryCommentLength !== 0) {
      throw new Error("Unsupported ZIP metadata in " + path + ".");
    }
    validateZipEntry(path, flags, method, packedSize, size, seen);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) {
      throw new Error("Package resource limit exceeded.");
    }

    const localFixed = await source.read(localOffset, 30);
    const localView = new DataView(
      localFixed.buffer,
      localFixed.byteOffset,
      localFixed.byteLength
    );
    if (localView.getUint32(0, true) !== LOCAL) {
      throw new Error("Invalid local header for " + path + ".");
    }
    const localNameLength = localView.getUint16(26, true);
    const localExtraLength = localView.getUint16(28, true);
    if (localExtraLength !== 0) {
      throw new Error("Unsupported ZIP metadata in " + path + ".");
    }
    const localVariable = await source.read(
      localOffset + 30,
      localNameLength + localExtraLength
    );
    const localPath = decode(localVariable.subarray(0, localNameLength));
    if (
      localPath !== path ||
      localView.getUint16(6, true) !== flags ||
      localView.getUint16(8, true) !== method ||
      localView.getUint32(14, true) !== checksum ||
      localView.getUint32(18, true) !== packedSize ||
      localView.getUint32(22, true) !== size
    ) {
      throw new Error("Local and central headers differ for " + path + ".");
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + packedSize > centralOffset) {
      throw new Error("Invalid data range for " + path + ".");
    }
    entries.push({
      path,
      compression: compressionFromMethod(method),
      compressedBytes: packedSize,
      uncompressedBytes: size,
      checksum,
      dataOffset
    });
    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (cursor !== central.length) {
    throw new Error("Invalid central-directory length.");
  }

  const readEntry = async (entry: RangedZipEntry) => {
      const packed = await source.read(entry.dataOffset, entry.compressedBytes);
      const data = await decompressBytes(packed, entry.compression);
      if (data.length !== entry.uncompressedBytes || crc32(data) !== entry.checksum) {
        throw new Error("Integrity check failed for " + entry.path + ".");
      }
      telemetry.entriesLoaded++;
      return data;
  };
  return {
    entries,
    readEntry,
    streamEntry(entry) {
      if (entry.compression !== "store") {
        let delivered = false;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (delivered) return;
            delivered = true;
            try {
              controller.enqueue(await readEntry(entry));
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          }
        });
      }
      let offset = 0;
      let checksum = 0xffffffff;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (offset === entry.compressedBytes) {
              const actual = (checksum ^ 0xffffffff) >>> 0;
              if (
                offset !== entry.uncompressedBytes ||
                actual !== entry.checksum
              ) {
                throw new Error("Integrity check failed for " + entry.path + ".");
              }
              telemetry.entriesLoaded++;
              controller.close();
              return;
            }
            const length = Math.min(
              1024 * 1024,
              entry.compressedBytes - offset
            );
            const chunk = await source.read(entry.dataOffset + offset, length);
            offset += chunk.length;
            checksum = crc32Update(checksum, chunk);
            controller.enqueue(chunk);
          } catch (error) {
            controller.error(error);
          }
        }
      });
    }
  };
}

function recordRange(
  ranges: Array<[number, number]>,
  start: number,
  end: number
): void {
  if (start === end) return;
  ranges.push([start, end]);
  ranges.sort((left, right) => left[0] - right[0]);
  let write = 0;
  for (const range of ranges) {
    const previous = ranges[write - 1];
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      ranges[write++] = range;
    }
  }
  ranges.length = write;
}

export async function materializeAsset(asset: AssetData): Promise<Uint8Array> {
  const data = asset.data ?? (await asset.load?.()) ?? (await collectAsset(asset));
  if (data.length !== asset.bytes) {
    throw new Error("Asset " + asset.id + " failed its size check.");
  }
  return data;
}

export async function writeZip(
  inputs: readonly WriteEntry[]
): Promise<Uint8Array> {
  const seen = new Set<string>();
  const entries: Array<{
    name: Uint8Array;
    data: Uint8Array;
    packed: Uint8Array;
    method: number;
    checksum: number;
    offset: number;
    version: number;
  }> = [];
  let offset = 0;

  for (const input of inputs) {
    safePath(input.path);
    if (seen.has(input.path)) throw new Error("Duplicate entry " + input.path);
    seen.add(input.path);
    const name = encoder.encode(input.path);
    const method =
      input.compression === "store"
        ? 0
        : input.compression === "deflate"
          ? 8
          : 93;
    const packed = await compressBytes(input.data, input.compression);
    entries.push({
      name,
      data: input.data,
      packed,
      method,
      checksum: crc32(input.data),
      offset,
      version: method === 93 ? 63 : 20
    });
    offset += 30 + name.length + packed.length;
  }

  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    u32(view, 0, LOCAL);
    u16(view, 4, entry.version);
    u16(view, 6, UTF8_FLAG);
    u16(view, 8, entry.method);
    u16(view, 12, DOS_DATE);
    u32(view, 14, entry.checksum);
    u32(view, 18, entry.packed.length);
    u32(view, 22, entry.data.length);
    u16(view, 26, entry.name.length);
    local.push(header, entry.name, entry.packed);

    const record = new Uint8Array(46);
    const centralView = new DataView(record.buffer);
    u32(centralView, 0, CENTRAL);
    u16(centralView, 4, 63);
    u16(centralView, 6, entry.version);
    u16(centralView, 8, UTF8_FLAG);
    u16(centralView, 10, entry.method);
    u16(centralView, 14, DOS_DATE);
    u32(centralView, 16, entry.checksum);
    u32(centralView, 20, entry.packed.length);
    u32(centralView, 24, entry.data.length);
    u16(centralView, 28, entry.name.length);
    u32(centralView, 42, entry.offset);
    central.push(record, entry.name);
  }

  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  u32(eocdView, 0, EOCD);
  u16(eocdView, 8, entries.length);
  u16(eocdView, 10, entries.length);
  u32(eocdView, 12, centralBytes.length);
  u32(eocdView, 16, offset);
  return concat([...local, centralBytes, eocd]);
}

export async function readZip(input: Uint8Array): Promise<PackageEntry[]> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const eocd = findEocd(view);
  ensure(view, eocd, 22);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskCount = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskCount !== count ||
    commentLength !== 0 ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocd ||
    eocd + 22 !== input.length
  ) {
    throw new Error("Invalid central directory.");
  }

  const entries: PackageEntry[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    ensure(view, cursor, 46);
    if (view.getUint32(cursor, true) !== CENTRAL) {
      throw new Error("Invalid central-directory signature.");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const packedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    ensure(view, cursor, 46 + nameLength + extraLength + commentLength);
    const path = decode(
      input.subarray(cursor + 46, cursor + 46 + nameLength)
    );
    if (extraLength !== 0 || commentLength !== 0) {
      throw new Error("Unsupported ZIP metadata in " + path + ".");
    }
    validateZipEntry(path, flags, method, packedSize, size, seen);
    expanded += size;
    if (count > MAX_ENTRIES || expanded > MAX_EXPANDED_BYTES) {
      throw new Error("Package resource limit exceeded.");
    }

    ensure(view, localOffset, 30);
    if (view.getUint32(localOffset, true) !== LOCAL) {
      throw new Error("Invalid local header for " + path + ".");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localChecksum = view.getUint32(localOffset + 14, true);
    const localPacked = view.getUint32(localOffset + 18, true);
    const localSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localExtraLength !== 0) {
      throw new Error("Unsupported ZIP metadata in " + path + ".");
    }
    const localPath = decode(
      input.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    );
    if (
      localPath !== path ||
      localFlags !== flags ||
      localMethod !== method ||
      localChecksum !== checksum ||
      localPacked !== packedSize ||
      localSize !== size
    ) {
      throw new Error("Local and central headers differ for " + path + ".");
    }
    const dataOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    ensure(view, dataOffset, packedSize);
    const packed = input.subarray(dataOffset, dataOffset + packedSize);
    const compression = compressionFromMethod(method);
    const data = await decompressBytes(packed, compression);
    if (data.length !== size || crc32(data) !== checksum) {
      throw new Error("Integrity check failed for " + path + ".");
    }
    entries.push({
      path,
      data,
      compression,
      compressedBytes: packedSize,
      uncompressedBytes: size
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new Error("Invalid central-directory length.");
  }
  return entries;
}

export function collectAssetIds(document: DocumentNode): Set<string> {
  const result = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.kind === "asset" && typeof object.id === "string") {
      result.add(object.id);
      return;
    }
    Object.values(object).forEach(visit);
  };
  visit(document);
  return result;
}

export function inferMediaType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".drawio.svg")) return "image/svg+xml";
  if (lower.endsWith(".drawio") || lower.endsWith(".dio")) return "application/vnd.jgraph.mxfile";
  if (lower.endsWith(".mmd") || lower.endsWith(".mermaid")) return "text/vnd.mermaid";
  if (lower.endsWith(".vl.json") || lower.endsWith(".vegalite.json")) return "application/vnd.vegalite+json";
  const extension = lower.match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
  return (
    {
      ".avif": "image/avif",
      ".jxl": "image/jxl",
      ".webp": "image/webp",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".opus": "audio/opus",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
      ".webm": "video/webm",
      ".mp4": "video/mp4",
      ".vtt": "text/vtt",
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".json": "application/json",
      ".csv": "text/csv",
      ".txt": "text/plain",
      ".pdf": "application/pdf"
    }[extension] ?? "application/octet-stream"
  );
}

export function inferKind(mediaType: string, fileName = ""): AssetData["kind"] {
  const lower = fileName.toLowerCase();
  if (mediaType === "text/vnd.mermaid" || mediaType === "application/vnd.jgraph.mxfile" || lower.endsWith(".drawio.svg")) return "diagram";
  if (["application/vnd.vegalite+json", "application/vnd.vegalite.v5+json", "application/vnd.vegalite.v6+json"].includes(mediaType)) return "data";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    return "data";
  }
  return "attachment";
}

export function inferRole(
  kind: AssetData["kind"],
  mediaType: string
): AssetData["role"] {
  if (mediaType === "text/vtt") return "captions";
  if (kind === "image" || kind === "audio" || kind === "video") {
    return "playback";
  }
  if (kind === "diagram") return "source";
  if (kind === "data") return "data";
  return "original";
}

async function compressBytes(
  data: Uint8Array,
  compression: Compression
): Promise<Uint8Array> {
  if (compression === "store") return data;
  if (compression === "deflate") return deflateSync(data, { level: 9 });
  await ensureZstd();
  return compress(data, 10);
}

async function decompressBytes(
  data: Uint8Array,
  compression: Compression
): Promise<Uint8Array> {
  if (compression === "store") return data;
  if (compression === "deflate") return inflateSync(data);
  await ensureZstd();
  return decompress(data);
}

function ensureZstd(): Promise<void> {
  zstdInitialization ??= init();
  return zstdInitialization;
}

function compressionFor(
  profile: ContainerProfile,
  mediaType: string
): Compression {
  if (compressible.has(mediaType) || mediaType.startsWith("text/")) {
    return profile === "modern-0.1" ? "zstd" : "deflate";
  }
  return "store";
}

function validateCompressionProfile(
  entries: readonly PackageEntry[],
  manifest: PackageManifest
): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const textCompression: Compression =
    manifest.containerProfile === "modern-0.1" ? "zstd" : "deflate";
  for (const path of ["manifest.json", manifest.source]) {
    if (required(byPath, path).compression !== textCompression) {
      throw new Error(
        `Entry ${path} violates the ${manifest.containerProfile} compression profile.`
      );
    }
  }
  for (const asset of Object.values(manifest.assets)) {
    for (const representation of asset.representations) {
      const entry = required(byPath, representation.path);
      const expected = compressionFor(
        manifest.containerProfile,
        representation.mediaType
      );
      if (entry.compression !== expected) {
        throw new Error(
          `Entry ${representation.path} violates the ${manifest.containerProfile} compression profile.`
        );
      }
    }
  }
}

function parseManifest(source: string): PackageManifest {
  const value = JSON.parse(source) as PackageManifest;
  if (
    value.format !== "notmarkdown" ||
    value.packageVersion !== "0.1" ||
    value.source !== "document.nmt" ||
    value.themeProfile !== "0.1" ||
    !["modern-0.1", "portable-0.1"].includes(value.containerProfile) ||
    typeof value.assets !== "object"
  ) {
    throw new Error("Invalid NotMarkdown manifest.");
  }
  return value;
}

function required(
  entries: ReadonlyMap<string, PackageEntry>,
  path: string
): PackageEntry {
  const value = entries.get(path);
  if (!value) throw new Error("Missing package entry " + path + ".");
  return value;
}

function requiredRanged(
  entries: ReadonlyMap<string, RangedZipEntry>,
  path: string
): RangedZipEntry {
  const value = entries.get(path);
  if (!value) throw new Error("Missing package entry " + path + ".");
  return value;
}

function eagerData(entry: PackageEntry): Uint8Array {
  if (!entry.data) throw new Error("Package entry " + entry.path + " is deferred.");
  return entry.data;
}

function compressionFromMethod(method: number): Compression {
  return method === 0 ? "store" : method === 8 ? "deflate" : "zstd";
}

function validateZipEntry(
  path: string,
  flags: number,
  method: number,
  packedSize: number,
  size: number,
  seen: Set<string>
): void {
  if (flags !== UTF8_FLAG || ![0, 8, 93].includes(method)) {
    throw new Error("Unsupported ZIP feature in " + path + ".");
  }
  safePath(path);
  if (seen.has(path)) throw new Error("Duplicate entry " + path + ".");
  seen.add(path);
  if (size > MAX_ENTRY_BYTES) {
    throw new Error("Package resource limit exceeded.");
  }
  if (
    size > 0 &&
    (packedSize === 0 || size / packedSize > MAX_COMPRESSION_RATIO)
  ) {
    throw new Error("Compression ratio limit exceeded.");
  }
}

function safeExtension(fileName: string, mediaType: string): string {
  const existing = fileName.toLowerCase().match(/(\.[a-z0-9]{1,10})$/)?.[1];
  if (existing) return existing;
  return (
    {
      "image/avif": ".avif",
      "image/svg+xml": ".svg",
      "audio/opus": ".opus",
      "video/webm": ".webm",
      "text/vtt": ".vtt",
      "application/json": ".json"
    }[mediaType] ?? ".bin"
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableJson(object[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function normalizeSource(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : normalized + "\n";
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Unsafe package path " + path + ".");
  }
}

function findEocd(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === EOCD) return offset;
  }
  throw new Error("Missing ZIP end record.");
}

function ensure(view: DataView, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new Error("Truncated package.");
  }
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function decode(data: Uint8Array): string {
  return decoder.decode(data);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  value = crc32Update(value, data);
  return (value ^ 0xffffffff) >>> 0;
}

function crc32Update(value: number, data: Uint8Array): number {
  for (const byte of data) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

function hex(data: Uint8Array): string {
  return [...data]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
