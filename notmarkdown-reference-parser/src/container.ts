import { createHash } from "node:crypto";
import { parse } from "./parser.js";
import type { DocumentNode } from "./types.js";
import {
  readZip,
  writeZip,
  ZipFormatError,
  type ZipCompression,
  type ZipOutputEntry,
  type ZipReadLimits
} from "./zip.js";

export type ContainerProfile = "portable-0.1" | "modern-0.1";
export type AssetKind =
  | "image"
  | "audio"
  | "video"
  | "diagram"
  | "data"
  | "attachment";
export type AssetRole =
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

export interface PackageAssetInput {
  id: string;
  fileName: string;
  data: Uint8Array;
  mediaType?: string;
  kind?: AssetKind;
  role?: AssetRole;
}

export interface CreatePackageOptions {
  source: string;
  assets?: readonly PackageAssetInput[];
  profile?: ContainerProfile;
  mediaProfile?: string;
}

export interface AssetRepresentation {
  path: string;
  mediaType: string;
  role: AssetRole;
  bytes: number;
  sha256: string;
}

export interface ManifestAsset {
  kind: AssetKind;
  representations: AssetRepresentation[];
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

export interface OpenPackageOptions extends ZipReadLimits {}

export interface OpenedPackage {
  manifest: PackageManifest;
  source: string;
  document: DocumentNode;
  entries: ReadonlyMap<string, ZipOutputEntry>;
}

const MIMETYPE = "application/vnd.notmarkdown.document+zip";
const REQUIRED_ROOT = new Set(["mimetype", "manifest.json", "document.nmt"]);
const COMPRESSIBLE_TYPES = new Set([
  "application/json",
  "application/vnd.jgraph.mxfile",
  "application/vnd.vegalite+json",
  "application/vnd.vegalite.v5+json",
  "application/vnd.vegalite.v6+json",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
  "text/csv",
  "text/css",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/vtt"
]);

export class PackageFormatError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageFormatError";
    this.code = code;
  }
}

export function createPackage(options: CreatePackageOptions): Buffer {
  const source = normalizeSource(options.source);
  const parsed = parse(source);
  if (!parsed.document) {
    const first = parsed.diagnostics[0];
    throw new PackageFormatError(
      "NMD_PACKAGE_SOURCE_INVALID",
      first
        ? first.code + ": " + first.message
        : "The document source is invalid."
    );
  }

  const profile = options.profile ?? "modern-0.1";
  const mediaProfile = options.mediaProfile ?? "2026-draft";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mediaProfile)) {
    throw new PackageFormatError(
      "NMD_MEDIA_PROFILE_INVALID",
      "The media-profile identifier is invalid."
    );
  }

  const assetInputs = [...(options.assets ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id, "en")
  );
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const assets: Record<string, ManifestAsset> = {};
  const assetEntries: Array<{
    path: string;
    data: Buffer;
    mediaType: string;
  }> = [];

  for (const input of assetInputs) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(input.id)) {
      throw new PackageFormatError(
        "NMD_ASSET_ID_INVALID",
        "Invalid asset ID " + input.id + "."
      );
    }
    if (seenIds.has(input.id)) {
      throw new PackageFormatError(
        "NMD_ASSET_DUPLICATE",
        "Duplicate asset ID " + input.id + "."
      );
    }
    seenIds.add(input.id);

    const mediaType = input.mediaType ?? inferMediaType(input.fileName);
    const extension = safeExtension(input.fileName, mediaType);
    const path = "assets/" + input.id + extension;
    if (seenPaths.has(path)) {
      throw new PackageFormatError(
        "NMD_ASSET_PATH_DUPLICATE",
        "Two assets resolve to " + path + "."
      );
    }
    seenPaths.add(path);

    const data = Buffer.from(input.data);
    const kind = input.kind ?? inferKind(mediaType, input.fileName);
    const role = input.role ?? inferRole(kind, mediaType);
    assets[input.id] = {
      kind,
      representations: [
        {
          path,
          mediaType,
          role,
          bytes: data.length,
          sha256: sha256(data)
        }
      ]
    };
    assetEntries.push({ path, data, mediaType });
  }

  const referenced = collectAssetIds(parsed.document);
  for (const id of referenced) {
    if (!Object.hasOwn(assets, id)) {
      throw new PackageFormatError(
        "NMD_ASSET_MISSING",
        "Document references missing asset " + id + "."
      );
    }
  }
  for (const id of Object.keys(assets)) {
    if (!referenced.has(id)) {
      throw new PackageFormatError(
        "NMD_ASSET_UNUSED",
        "Asset " + id + " is not referenced by the document."
      );
    }
  }

  const sourceBytes = Buffer.from(source, "utf8");
  const manifest: PackageManifest = {
    format: "notmarkdown",
    packageVersion: "0.1",
    source: "document.nmt",
    sourceSha256: sha256(sourceBytes),
    containerProfile: profile,
    themeProfile: "0.1",
    mediaProfile,
    assets
  };
  const manifestBytes = Buffer.from(stableJson(manifest) + "\n", "utf8");

  return writeZip([
    {
      path: "mimetype",
      data: Buffer.from(MIMETYPE, "ascii"),
      compression: "store"
    },
    {
      path: "manifest.json",
      data: manifestBytes,
      compression: textCompression(profile)
    },
    {
      path: "document.nmt",
      data: sourceBytes,
      compression: textCompression(profile)
    },
    ...assetEntries.map((entry) => ({
      path: entry.path,
      data: entry.data,
      compression: assetCompression(profile, entry.mediaType)
    }))
  ]);
}

export function openPackage(
  input: Uint8Array,
  options: OpenPackageOptions = {}
): OpenedPackage {
  let zipEntries: ZipOutputEntry[];
  try {
    zipEntries = readZip(input, options);
  } catch (error) {
    if (error instanceof ZipFormatError) {
      throw new PackageFormatError(error.code, error.message);
    }
    throw error;
  }
  if (zipEntries.length < 3 || zipEntries[0]?.path !== "mimetype") {
    throw new PackageFormatError(
      "NMD_PACKAGE_MIMETYPE_POSITION",
      "The uncompressed mimetype entry must be first."
    );
  }
  const entries = new Map(zipEntries.map((entry) => [entry.path, entry]));
  const mimetype = entries.get("mimetype");
  if (
    !mimetype ||
    mimetype.compression !== "store" ||
    mimetype.data.toString("ascii") !== MIMETYPE
  ) {
    throw new PackageFormatError(
      "NMD_PACKAGE_MIMETYPE_INVALID",
      "The package mimetype entry is invalid."
    );
  }
  const manifestEntry = requireEntry(entries, "manifest.json");
  const sourceEntry = requireEntry(entries, "document.nmt");
  const manifest = parseManifest(decodeUtf8(manifestEntry.data, "manifest.json"));
  const source = decodeUtf8(sourceEntry.data, "document.nmt");

  if (sha256(sourceEntry.data) !== manifest.sourceSha256) {
    throw new PackageFormatError(
      "NMD_PACKAGE_SOURCE_HASH",
      "The document source failed its SHA-256 integrity check."
    );
  }
  const parsed = parse(source);
  if (!parsed.document) {
    const first = parsed.diagnostics[0];
    throw new PackageFormatError(
      "NMD_PACKAGE_SOURCE_INVALID",
      first ? first.code + ": " + first.message : "Invalid document source."
    );
  }

  const expectedPaths = new Set(REQUIRED_ROOT);
  for (const [id, asset] of Object.entries(manifest.assets)) {
    for (const representation of asset.representations) {
      if (expectedPaths.has(representation.path)) {
        throw new PackageFormatError(
          "NMD_MANIFEST_PATH_DUPLICATE",
          "Manifest path " + representation.path + " is used more than once."
        );
      }
      expectedPaths.add(representation.path);
      const entry = requireEntry(entries, representation.path);
      if (
        entry.data.length !== representation.bytes ||
        sha256(entry.data) !== representation.sha256
      ) {
        throw new PackageFormatError(
          "NMD_ASSET_INTEGRITY",
          "Asset " + id + " failed its size or SHA-256 check."
        );
      }
      const expectedCompression = assetCompression(
        manifest.containerProfile,
        representation.mediaType
      );
      if (entry.compression !== expectedCompression) {
        throw new PackageFormatError(
          "NMD_PACKAGE_COMPRESSION_PROFILE",
          "Entry " + representation.path + " violates the container profile."
        );
      }
    }
  }
  for (const path of entries.keys()) {
    if (!expectedPaths.has(path)) {
      throw new PackageFormatError(
        "NMD_PACKAGE_ENTRY_UNDECLARED",
        "Package entry " + path + " is not declared by the manifest."
      );
    }
  }

  const requiredTextCompression = textCompression(manifest.containerProfile);
  if (
    manifestEntry.compression !== requiredTextCompression ||
    sourceEntry.compression !== requiredTextCompression
  ) {
    throw new PackageFormatError(
      "NMD_PACKAGE_COMPRESSION_PROFILE",
      "Manifest or source compression violates the container profile."
    );
  }

  const references = collectAssetIds(parsed.document);
  for (const id of references) {
    if (!Object.hasOwn(manifest.assets, id)) {
      throw new PackageFormatError(
        "NMD_ASSET_MISSING",
        "Document references missing asset " + id + "."
      );
    }
  }
  for (const id of Object.keys(manifest.assets)) {
    if (!references.has(id)) {
      throw new PackageFormatError(
        "NMD_ASSET_UNUSED",
        "Manifest asset " + id + " is not referenced."
      );
    }
  }

  return {
    manifest,
    source,
    document: parsed.document,
    entries
  };
}

export function inferMediaType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".drawio.svg")) return "image/svg+xml";
  if (lower.endsWith(".vegalite.json") || lower.endsWith(".vl.json")) {
    return "application/vnd.vegalite+json";
  }
  const extension = lower.match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
  const known: Record<string, string> = {
    ".avif": "image/avif",
    ".jxl": "image/jxl",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".mmd": "text/vnd.mermaid",
    ".mermaid": "text/vnd.mermaid",
    ".drawio": "application/vnd.jgraph.mxfile",
    ".dio": "application/vnd.jgraph.mxfile",
    ".opus": "audio/opus",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".vtt": "text/vtt",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".pdf": "application/pdf"
  };
  return known[extension] ?? "application/octet-stream";
}

export function collectAssetIds(document: DocumentNode): Set<string> {
  const result = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
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

function parseManifest(source: string): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new PackageFormatError(
      "NMD_MANIFEST_JSON_INVALID",
      "manifest.json is not valid JSON."
    );
  }
  if (!isRecord(value)) {
    throw new PackageFormatError(
      "NMD_MANIFEST_INVALID",
      "The manifest root must be an object."
    );
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "assets",
    "containerProfile",
    "format",
    "mediaProfile",
    "packageVersion",
    "source",
    "sourceSha256",
    "themeProfile"
  ];
  if (keys.join("\0") !== expected.join("\0")) {
    throw new PackageFormatError(
      "NMD_MANIFEST_FIELDS",
      "The manifest has missing or unknown root fields."
    );
  }
  if (
    value.format !== "notmarkdown" ||
    value.packageVersion !== "0.1" ||
    value.source !== "document.nmt" ||
    value.themeProfile !== "0.1" ||
    (value.containerProfile !== "portable-0.1" &&
      value.containerProfile !== "modern-0.1") ||
    typeof value.mediaProfile !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.mediaProfile) ||
    typeof value.sourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sourceSha256) ||
    !isRecord(value.assets)
  ) {
    throw new PackageFormatError(
      "NMD_MANIFEST_INVALID",
      "The manifest root contains invalid values."
    );
  }

  const assets: Record<string, ManifestAsset> = {};
  for (const [id, rawAsset] of Object.entries(value.assets)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id) || !isRecord(rawAsset)) {
      throw new PackageFormatError(
        "NMD_MANIFEST_ASSET_INVALID",
        "Manifest asset " + id + " is invalid."
      );
    }
    if (
      !validKind(rawAsset.kind) ||
      !Array.isArray(rawAsset.representations) ||
      rawAsset.representations.length === 0
    ) {
      throw new PackageFormatError(
        "NMD_MANIFEST_ASSET_INVALID",
        "Manifest asset " + id + " is invalid."
      );
    }
    const representations = rawAsset.representations.map((item) =>
      parseRepresentation(item, id)
    );
    assets[id] = { kind: rawAsset.kind, representations };
  }

  return {
    format: "notmarkdown",
    packageVersion: "0.1",
    source: "document.nmt",
    sourceSha256: value.sourceSha256,
    containerProfile: value.containerProfile,
    themeProfile: "0.1",
    mediaProfile: value.mediaProfile,
    assets
  };
}

function parseRepresentation(value: unknown, id: string): AssetRepresentation {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !safeManifestAssetPath(value.path) ||
    typeof value.mediaType !== "string" ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType) ||
    !validRole(value.role) ||
    !Number.isInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > 0xffffffff ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new PackageFormatError(
      "NMD_MANIFEST_REPRESENTATION_INVALID",
      "Asset representation for " + id + " is invalid."
    );
  }
  return {
    path: value.path,
    mediaType: value.mediaType,
    role: value.role,
    bytes: value.bytes as number,
    sha256: value.sha256
  };
}

function validKind(value: unknown): value is AssetKind {
  return (
    value === "image" ||
    value === "audio" ||
    value === "video" ||
    value === "diagram" ||
    value === "data" ||
    value === "attachment"
  );
}

function validRole(value: unknown): value is AssetRole {
  return (
    value === "playback" ||
    value === "original" ||
    value === "fallback" ||
    value === "poster" ||
    value === "thumbnail" ||
    value === "waveform" ||
    value === "captions" ||
    value === "transcript" ||
    value === "chapters" ||
    value === "source" ||
    value === "data"
  );
}

function textCompression(profile: ContainerProfile): ZipCompression {
  return profile === "modern-0.1" ? "zstd" : "deflate";
}

function assetCompression(
  profile: ContainerProfile,
  mediaType: string
): ZipCompression {
  if (COMPRESSIBLE_TYPES.has(mediaType) || mediaType.startsWith("text/")) {
    return profile === "modern-0.1" ? "zstd" : "deflate";
  }
  return "store";
}

function inferKind(mediaType: string, fileName = ""): AssetKind {
  const lowerName = fileName.toLowerCase();
  if (
    lowerName.endsWith(".drawio.svg") ||
    mediaType === "text/vnd.mermaid" ||
    mediaType === "application/vnd.jgraph.mxfile"
  ) {
    return "diagram";
  }
  if (isVegaLiteMediaType(mediaType)) return "data";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml"
  ) return "data";
  return "attachment";
}

function inferRole(kind: AssetKind, mediaType: string): AssetRole {
  if (mediaType === "text/vtt") return "captions";
  if (kind === "image" || kind === "audio" || kind === "video") {
    return "playback";
  }
  if (kind === "diagram") return "source";
  if (kind === "data") return "data";
  return "original";
}

function safeExtension(fileName: string, mediaType: string): string {
  const lower = fileName.toLowerCase();
  for (const compound of [
    ".vegalite.json",
    ".drawio.svg",
    ".vl.json"
  ]) {
    if (lower.endsWith(compound)) return compound;
  }
  const extension = lower.match(/(\.[a-z0-9]{1,10})$/)?.[1];
  if (extension) return extension;
  const preferred: Record<string, string> = {
    "application/json": ".json",
    "application/vnd.jgraph.mxfile": ".drawio",
    "application/vnd.vegalite+json": ".vl.json",
    "application/vnd.vegalite.v5+json": ".vl.json",
    "application/vnd.vegalite.v6+json": ".vl.json",
    "application/pdf": ".pdf",
    "image/avif": ".avif",
    "image/jxl": ".jxl",
    "image/svg+xml": ".svg",
    "text/plain": ".txt",
    "text/vnd.mermaid": ".mmd",
    "text/vtt": ".vtt",
    "video/webm": ".webm",
    "audio/opus": ".opus"
  };
  return preferred[mediaType] ?? ".bin";
}

function isVegaLiteMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/vnd.vegalite+json" ||
    mediaType === "application/vnd.vegalite.v5+json" ||
    mediaType === "application/vnd.vegalite.v6+json"
  );
}

function safeManifestAssetPath(path: string): boolean {
  return (
    path.startsWith("assets/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  if (isRecord(value)) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(value: Buffer, path: string): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new PackageFormatError(
      "NMD_PACKAGE_UTF8",
      path + " is not valid UTF-8."
    );
  }
  return decoded;
}

function requireEntry(
  entries: ReadonlyMap<string, ZipOutputEntry>,
  path: string
): ZipOutputEntry {
  const value = entries.get(path);
  if (!value) {
    throw new PackageFormatError(
      "NMD_PACKAGE_ENTRY_MISSING",
      "Required package entry " + path + " is missing."
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
