import {
  assertRepresentationLoadable,
  inferKind,
  inferMediaType,
  inferRole,
  type AssetData,
  type AssetRepresentationData
} from "./container";

export interface ValidatedImageFile {
  mediaType: string;
  kind: "image";
  role: "playback";
  bytes: number;
  fileName: string;
}

let sessionImageRevision = 0;

/**
 * Resolves browser file metadata using the same filename-first policy as the
 * package authoring UI and applies the existing browser authoring limits.
 */
export function validateImageFile(file: File): ValidatedImageFile {
  const inferred = inferMediaType(file.name);
  const mediaType =
    inferred !== "application/octet-stream"
      ? inferred
      : file.type || inferred;
  const kind = inferKind(mediaType, file.name);
  if (kind !== "image") {
    throw new Error("Choose an image file.");
  }
  const role = inferRole(kind, mediaType);
  if (role !== "playback") {
    throw new Error("Image files must use a playback representation.");
  }

  const validated: ValidatedImageFile = {
    mediaType,
    kind,
    role,
    bytes: file.size,
    fileName: file.name
  };
  const representation: AssetRepresentationData = {
    fileName: validated.fileName,
    mediaType: validated.mediaType,
    fingerprint: "pending-image-validation",
    role: validated.role,
    bytes: validated.bytes
  };
  const provisional: AssetData = {
    id: "image",
    kind: validated.kind,
    ...representation
  };
  assertRepresentationLoadable(provisional, representation, "author");
  return validated;
}

/** Allocates a package-safe, case-insensitively unique ID from a filename. */
export function allocateImageAssetId(
  fileName: string,
  existingIds: Iterable<string>
): string {
  const leaf = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const extension = leaf.lastIndexOf(".");
  const stem = extension > 0 ? leaf.slice(0, extension) : extension === 0 ? "" : leaf;
  let base = stem
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "image";
  if (!/^[a-z]/.test(base)) base = "image-" + base;

  const used = new Set([...existingIds].map((id) => id.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`.toLowerCase())) suffix++;
  return `${base}-${suffix}`;
}

/**
 * Creates an eagerly materialized image asset suitable for immediate canvas
 * preview. No asset is returned until validation and the single local read
 * have both succeeded.
 */
export async function createImageAsset(
  file: File,
  existingIds: Iterable<string>
): Promise<AssetData> {
  const metadata = validateImageFile(file);
  const id = allocateImageAssetId(file.name, existingIds);
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.byteLength !== metadata.bytes) {
    throw new Error("Image file changed while it was loading.");
  }
  const representation: AssetRepresentationData = {
    fileName: metadata.fileName,
    mediaType: metadata.mediaType,
    fingerprint: `session-image-${++sessionImageRevision}-${metadata.bytes}-${file.lastModified}`,
    role: metadata.role,
    bytes: metadata.bytes,
    data
  };
  return {
    id,
    kind: metadata.kind,
    ...representation,
    representations: [representation]
  };
}
