import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentNode } from "@notmarkdown/reference-toolchain";
import { sanitizeSvg } from "../core/visual-renderers";
import { DOCUMENT_THEME_OPTIONS } from "../core/document-appearance";
import {
  assertRepresentationLoadable,
  assetRepresentations,
  collectAssetIds,
  inferKind,
  inferMediaType,
  inferRole,
  selectAssetRepresentationIndex,
  type AssetData,
  type AssetRepresentationData,
  type ContainerProfile
} from "../core/container";

let sessionAssetRevision = 0;

interface Props {
  document: DocumentNode;
  assets: readonly AssetData[];
  assetUrls: ReadonlyMap<string, string>;
  profile: ContainerProfile;
  onProfileChange: (profile: ContainerProfile) => void;
  onAssetsChange: (assets: AssetData[]) => void;
  onLoadAsset: (
    id: string,
    representationIndex?: number,
    purpose?: "preview" | "author" | "materialize"
  ) => Promise<Uint8Array>;
  onMetadataChange: (key: string, value: string) => void;
}

export function PackageView({
  document,
  assets,
  assetUrls,
  profile,
  onProfileChange,
  onAssetsChange,
  onLoadAsset,
  onMetadataChange
}: Props) {
  const [assetId, setAssetId] = useState("");
  const [loadingId, setLoadingId] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const referenced = useMemo(() => collectAssetIds(document), [document]);
  const previewable = assets.filter(
    (asset) =>
      ["image", "audio", "video"].includes(asset.kind) ||
      (asset.kind === "diagram" && asset.mediaType === "image/svg+xml")
  );
  const totalBytes = assets.reduce(
    (sum, asset) =>
      sum + assetRepresentations(asset).reduce((subtotal, item) => subtotal + item.bytes, 0),
    0
  );

  const load = async (
    asset: AssetData,
    representationIndex = selectAssetRepresentationIndex(asset),
    purpose: "preview" | "author" | "materialize" = "preview"
  ): Promise<Uint8Array | undefined> => {
    const key = asset.id + ":" + representationIndex;
    setLoadingId(key);
    setLoadError(undefined);
    try {
      return await onLoadAsset(asset.id, representationIndex, purpose);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setLoadingId(undefined);
    }
  };

  const extract = async (
    asset: AssetData,
    representation: AssetRepresentationData,
    representationIndex: number
  ) => {
    const data =
      representation.data ??
      (await load(asset, representationIndex, "materialize"));
    if (!data) return;
    download(
      new Blob([toArrayBuffer(data)], { type: representation.mediaType }),
      representation.fileName
    );
  };

  const replaceRepresentation = async (
    asset: AssetData,
    representationIndex: number,
    file: File
  ) => {
    try {
      const representations = assetRepresentations(asset);
      const previous = representations[representationIndex];
      if (!previous) throw new Error("Unknown representation.");
      const mediaType = fileMediaType(file);
      if (inferKind(mediaType, file.name) !== asset.kind) {
        throw new Error("Replacement must keep the logical asset kind.");
      }
      const candidate: AssetRepresentationData = {
        ...(previous.path ? { path: previous.path } : {}),
        fileName: file.name,
        mediaType,
        fingerprint: `session-${++sessionAssetRevision}-${file.size}-${file.lastModified}`,
        role: previous.role,
        bytes: file.size
      };
      assertRepresentationLoadable(asset, candidate, "author");
      const data = new Uint8Array(await file.arrayBuffer());
      validateVisualFile(candidate, data);
      representations[representationIndex] = { ...candidate, data };
      onAssetsChange(
        assets.map((item) =>
          item.id === asset.id
            ? rebuildAsset(item, representations)
            : item
        )
      );
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const addRepresentation = async (asset: AssetData, file: File) => {
    try {
      const mediaType = fileMediaType(file);
      if (inferKind(mediaType, file.name) !== asset.kind) {
        throw new Error("Representation must match the logical asset kind.");
      }
      const representation: AssetRepresentationData = {
        fileName: file.name,
        mediaType,
        fingerprint: `session-${++sessionAssetRevision}-${file.size}-${file.lastModified}`,
        role: inferRole(asset.kind, mediaType),
        bytes: file.size
      };
      assertRepresentationLoadable(asset, representation, "author");
      const data = new Uint8Array(await file.arrayBuffer());
      validateVisualFile(representation, data);
      const representations = [...assetRepresentations(asset), { ...representation, data }];
      onAssetsChange(
        assets.map((item) =>
          item.id === asset.id ? rebuildAsset(item, representations) : item
        )
      );
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const addFile = async (file: File) => {
    const id = assetId.trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) return;
    if (assets.some((asset) => asset.id === id)) return;
    const mediaType = fileMediaType(file);
    const kind = inferKind(mediaType, file.name);
    const draft: AssetRepresentationData = {
      fileName: file.name,
      mediaType,
      fingerprint: `session-${++sessionAssetRevision}-${file.size}-${file.lastModified}`,
      role: inferRole(kind, mediaType),
      bytes: file.size
    };
    const draftAsset = { id, kind, ...draft } as AssetData;
    assertRepresentationLoadable(draftAsset, draft, "author");
    const eager = kind === "diagram" ? new Uint8Array(await file.arrayBuffer()) : undefined;
    if (eager) validateVisualFile(draft, eager);
    const representation: AssetRepresentationData = {
      ...draft,
      data: eager,
      load: async () => eager ?? new Uint8Array(await file.arrayBuffer()),
      openStream: () => file.stream()
    };
    onAssetsChange([
      ...assets,
      {
        id,
        kind,
        ...representation,
        representations: [representation]
      }
    ]);
    setAssetId("");
    if (input.current) input.current.value = "";
  };

  return (
    <div className="package-view">
      <section className="package-summary">
        <div>
          <span className="eyebrow">Package</span>
          <h2>{document.metadata.title || "Untitled document"}</h2>
          <p>
            {assets.length} assets · {formatBytes(totalBytes)} uncompressed
          </p>
        </div>
        <label className="profile-control">
          Container profile
          <select
            value={profile}
            onChange={(event) =>
              onProfileChange(event.target.value as ContainerProfile)
            }
          >
            <option value="modern-0.1">Modern · Zstandard</option>
            <option value="portable-0.1">Portable · Deflate</option>
          </select>
        </label>
      </section>

      <section className="metadata-panel">
        <h3>Document metadata</h3>
        <div className="metadata-grid">
          <label>
            Title
            <input
              value={String(document.metadata.title ?? "")}
              onChange={(event) => onMetadataChange("title", event.target.value)}
            />
          </label>
          <label>
            Language
            <input
              value={String(document.metadata.language ?? "")}
              placeholder="en"
              onChange={(event) =>
                onMetadataChange("language", event.target.value)
              }
            />
          </label>
          <label>
            Theme
            <select
              value={String(document.metadata.theme ?? "standard")}
              onChange={(event) => onMetadataChange("theme", event.target.value)}
            >
              {DOCUMENT_THEME_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Accent
            <select
              value={String(document.metadata.accent ?? "violet")}
              onChange={(event) => onMetadataChange("accent", event.target.value)}
            >
              <option value="violet">Violet</option>
              <option value="blue">Blue</option>
              <option value="green">Green</option>
              <option value="orange">Orange</option>
              <option value="neutral">Neutral</option>
            </select>
          </label>
        </div>
      </section>

      <section className="asset-panel">
        <div className="section-heading">
          <div>
            <h3>Assets</h3>
            <p>Embedded resources stay inside the document.</p>
          </div>
          <div className="asset-add">
            <input
              value={assetId}
              placeholder="asset-id"
              aria-label="New asset ID"
              onChange={(event) => setAssetId(event.target.value)}
            />
            <label className={"file-button " + (!assetId ? "disabled" : "")}>
              Add file
              <input
                ref={input}
                type="file"
                disabled={!assetId}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void addFile(file);
                }}
              />
            </label>
          </div>
        </div>

        {assets.length === 0 ? (
          <div className="empty-assets">
            <span>◇</span>
            <strong>No embedded assets yet</strong>
            <p>Choose an ID, then add an image, audio, video, or attachment.</p>
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map((asset) => (
              <article className="asset-card" key={asset.id}>
                <AssetPreview asset={asset} url={assetUrls.get(asset.id)} />
                <div className="asset-info">
                  <div className="asset-title">
                    <strong>{asset.id}</strong>
                    <span className={"usage " + (referenced.has(asset.id) ? "used" : "")}>
                      {referenced.has(asset.id) ? "used" : "unused"}
                    </span>
                  </div>
                  <span>
                    {assetRepresentations(asset).length} {assetRepresentations(asset).length === 1 ? "representation" : "representations"}
                  </span>
                  <div className="representation-list">
                    {assetRepresentations(asset).map((representation, index) => {
                      const key = asset.id + ":" + index;
                      return (
                        <div className="representation-row" key={representation.path ?? `${representation.fileName}:${index}`}>
                          <div>
                            <strong>{representation.fileName}</strong>
                            <span>{representation.role} · {representation.mediaType}</span>
                            <span>{formatBytes(representation.bytes)} · {representation.data ? "loaded" : "deferred"}</span>
                          </div>
                          <div className="asset-actions">
                            {!representation.data && (
                              <button
                                disabled={loadingId === key}
                                onClick={() => void load(asset, index, "author")}
                              >
                                {loadingId === key ? "Loading…" : "Load"}
                              </button>
                            )}
                            <button
                              disabled={loadingId === key}
                              onClick={() => void extract(asset, representation, index)}
                            >
                              Extract
                            </button>
                            <label className="compact-file-button">
                              Replace
                              <input
                                type="file"
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (file) void replaceRepresentation(asset, index, file);
                                  event.target.value = "";
                                }}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="asset-actions">
                    <label className="compact-file-button">
                      Add representation
                      <input
                        type="file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void addRepresentation(asset, file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      disabled={referenced.has(asset.id)}
                      title={
                        referenced.has(asset.id)
                          ? "Remove the document reference first"
                          : "Remove asset"
                      }
                      onClick={() =>
                        onAssetsChange(
                          assets.filter((candidate) => candidate.id !== asset.id)
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {loadError && <p className="status-error">{loadError}</p>}
      </section>

      <section className="preview-panel">
        <div className="section-heading">
          <div>
            <h3>Generated previews</h3>
            <p>
              Local session previews are derived from embedded assets and are
              never authoritative document content.
            </p>
          </div>
          <span className="preview-count">{previewable.length}</span>
        </div>
        {previewable.length === 0 ? (
          <div className="preview-empty">
            Previews appear here after adding an image, audio, or video asset.
          </div>
        ) : (
          <div className="preview-grid">
            {previewable.map((asset) => (
              <article className="preview-card" key={asset.id}>
                <AssetPreview asset={asset} url={assetUrls.get(asset.id)} />
                <div>
                  <strong>{asset.id}</strong>
                  <span>{asset.data ? `${asset.kind} preview` : "preview deferred"}</span>
                  {!asset.data && (
                    <button
                      disabled={loadingId === asset.id + ":" + selectAssetRepresentationIndex(asset)}
                      onClick={() => void load(asset)}
                    >
                      {loadingId === asset.id + ":" + selectAssetRepresentationIndex(asset) ? "Loading…" : "Load"}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AssetPreview({ asset, url }: { asset: AssetData; url?: string }) {
  if (url && asset.kind === "image") {
    return <img className="asset-preview" src={url} alt="" />;
  }
  if (url && asset.kind === "audio") {
    return <audio className="asset-preview audio" src={url} controls />;
  }
  if (url && asset.kind === "video") {
    return <video className="asset-preview" src={url} controls preload="metadata" />;
  }
  if (asset.kind === "diagram" && asset.mediaType === "image/svg+xml" && asset.data) {
    return <SafeDiagramPreview bytes={asset.data} />;
  }
  return <div className="asset-preview fallback">{iconFor(asset.kind)}</div>;
}

function SafeDiagramPreview({ bytes }: { bytes: Uint8Array }) {
  const result = useMemo(() => {
    try {
      if (bytes.byteLength > 4 * 1024 * 1024) {
        throw new Error("draw.io SVG preview exceeds the 4 MiB preview limit.");
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateDrawioSvg(source);
      const sanitized = sanitizeSvg(source);
      return {
        url: URL.createObjectURL(new Blob([sanitized], { type: "image/svg+xml" }))
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [bytes]);
  useEffect(
    () => () => {
      if (result.url) URL.revokeObjectURL(result.url);
    },
    [result]
  );
  if (!result.url) {
    return <div className="asset-preview fallback">{result.error ?? "Invalid SVG preview"}</div>;
  }
  return <img className="asset-preview" src={result.url} alt="Sanitized draw.io SVG preview" />;
}

function validateDrawioXml(bytes: Uint8Array) {
  if (bytes.byteLength > 1024 * 1024) throw new Error("draw.io source exceeds the 1 MiB authoring limit.");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE/i.test(source)) throw new Error("draw.io DOCTYPE declarations are not allowed.");
  const parsed = new DOMParser().parseFromString(source, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("Invalid draw.io XML.");
  const root = parsed.documentElement.localName;
  if (root !== "mxfile" && root !== "mxGraphModel") throw new Error("Expected a draw.io mxfile or mxGraphModel root.");
}

function validateDrawioSvg(source: string) {
  if (/<!DOCTYPE/i.test(source)) throw new Error("SVG DOCTYPE declarations are not allowed.");
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") {
    throw new Error("Invalid draw.io SVG.");
  }
}

function validateVisualFile(
  representation: AssetRepresentationData,
  bytes: Uint8Array
) {
  if (representation.mediaType === "application/vnd.jgraph.mxfile") {
    validateDrawioXml(bytes);
  } else if (
    representation.mediaType === "image/svg+xml" &&
    representation.fileName.toLowerCase().endsWith(".drawio.svg")
  ) {
    if (bytes.byteLength > 4 * 1024 * 1024) {
      throw new Error("draw.io SVG exceeds the 4 MiB authoring limit.");
    }
    validateDrawioSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
}

function rebuildAsset(
  asset: AssetData,
  representations: AssetRepresentationData[]
): AssetData {
  const provisional: AssetData = {
    ...asset,
    ...representations[0]!,
    representations
  };
  const selected = representations[selectAssetRepresentationIndex(provisional)]!;
  return { ...asset, ...selected, representations };
}

function fileMediaType(file: File): string {
  const inferred = inferMediaType(file.name);
  return inferred !== "application/octet-stream"
    ? inferred
    : file.type || inferred;
}

function iconFor(kind: AssetData["kind"]) {
  return kind === "attachment" ? "▤" : kind === "data" ? "{ }" : kind === "diagram" ? "◇" : "◇";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}
