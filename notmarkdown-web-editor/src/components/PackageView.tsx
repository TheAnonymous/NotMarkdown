import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentNode } from "@notmarkdown/reference-toolchain";
import { sanitizeSvg } from "../core/visual-renderers";
import {
  collectAssetIds,
  inferKind,
  inferMediaType,
  inferRole,
  type AssetData,
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
  onLoadAsset: (id: string) => Promise<Uint8Array>;
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
  const previewable = assets.filter((asset) =>
    ["image", "audio", "video"].includes(asset.kind)
  );
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);

  const load = async (asset: AssetData): Promise<Uint8Array | undefined> => {
    setLoadingId(asset.id);
    setLoadError(undefined);
    try {
      return await onLoadAsset(asset.id);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setLoadingId(undefined);
    }
  };

  const extract = async (asset: AssetData) => {
    const data = asset.data ?? (await load(asset));
    if (!data) return;
    download(
      new Blob([toArrayBuffer(data)], { type: asset.mediaType }),
      asset.fileName
    );
  };

  const addFile = async (file: File) => {
    const id = assetId.trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) return;
    if (assets.some((asset) => asset.id === id)) return;
    const mediaType = file.type || inferMediaType(file.name);
    const kind = inferKind(mediaType, file.name);
    const eager = kind === "diagram" ? new Uint8Array(await file.arrayBuffer()) : undefined;
    if (mediaType === "application/vnd.jgraph.mxfile" && eager) validateDrawioXml(eager);
    onAssetsChange([
      ...assets,
      {
        id,
        fileName: file.name,
        mediaType,
        fingerprint: `session-${++sessionAssetRevision}-${file.size}-${file.lastModified}`,
        kind,
        role: inferRole(kind, mediaType),
        bytes: file.size,
        data: eager,
        load: async () => eager ?? new Uint8Array(await file.arrayBuffer()),
        openStream: () => file.stream()
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
              <option value="standard">Standard</option>
              <option value="paper">Paper</option>
              <option value="technical">Technical</option>
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
                  <span>{asset.fileName}</span>
                  <span>
                    {asset.mediaType} · {formatBytes(asset.bytes)} ·{" "}
                    {asset.data ? "loaded" : "deferred"}
                  </span>
                  <div className="asset-actions">
                    {!asset.data && ["image", "audio", "video"].includes(asset.kind) && (
                      <button
                        disabled={loadingId === asset.id}
                        onClick={() => void load(asset)}
                      >
                        {loadingId === asset.id ? "Loading…" : "Load preview"}
                      </button>
                    )}
                    <button
                      disabled={loadingId === asset.id}
                      onClick={() => void extract(asset)}
                    >
                      Extract
                    </button>
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
                      disabled={loadingId === asset.id}
                      onClick={() => void load(asset)}
                    >
                      {loadingId === asset.id ? "Loading…" : "Load"}
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
  const url = useMemo(() => {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const sanitized = sanitizeSvg(source);
    return URL.createObjectURL(new Blob([sanitized], { type: "image/svg+xml" }));
  }, [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="asset-preview" src={url} alt="Sanitized draw.io SVG preview" />;
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
