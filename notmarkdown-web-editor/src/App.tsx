import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import type {
  Diagnostic,
  DocumentNode
} from "@notmarkdown/reference-toolchain";
import type {
  AssetData,
  AssetRepresentationData,
  ContainerProfile
} from "./core/container";
import {
  browserLaunchQueue,
  requireNotMarkdownFile,
  takePendingSharedFile
} from "./core/file-intake";
import {
  loadReadingMode,
  normalizeDocumentAccent,
  normalizeDocumentTheme,
  storeReadingMode,
  type DocumentTheme
} from "./core/document-appearance";
import { createImageAsset } from "./core/image-authoring";

const DocumentEditor = lazy(() =>
  import("./components/DocumentEditor").then((module) => ({
    default: module.DocumentEditor
  }))
);
const SourceEditor = lazy(() =>
  import("./components/SourceEditor").then((module) => ({
    default: module.SourceEditor
  }))
);
const PackageView = lazy(() =>
  import("./components/PackageView").then((module) => ({
    default: module.PackageView
  }))
);

type ViewName = "document" | "source" | "package";

const initialSource = [
  "@notmarkdown 0.1",
  "",
  "@document {",
  '  title: "Welcome to NotMarkdown"',
  "  language: en",
  "  theme: technical",
  "  accent: violet",
  "}",
  "",
  "# One document. Three honest views.",
  "",
  "!toc{depth=2}",
  "",
  "Write visually, inspect the source, and keep every asset inside one portable file.",
  "",
  "!note[This editor works locally. Your document does not need to leave the browser.]",
  "",
  "## What already works",
  "",
  "1. Edit this document",
  "1. Switch to **Source**",
  "1. Inspect the **Package**",
  "1. Save a real .nmdoc file"
].join("\n");

const parsedInitial = parse(initialSource);
if (!parsedInitial.document) throw new Error("Invalid built-in document.");
const initialDocument = parsedInitial.document as DocumentNode;
let pendingSharedFile: Promise<File> | undefined;

export default function App() {
  const embedded = useMemo(
    () => new URLSearchParams(window.location.search).get("embed") === "1",
    []
  );
  const [activeView, setActiveView] = useState<ViewName>("document");
  const [source, setSource] = useState(initialSource + "\n");
  const [document, setDocument] = useState<DocumentNode>(initialDocument);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [assets, setAssets] = useState<AssetData[]>([]);
  const [assetVersion, setAssetVersion] = useState(0);
  const [profile, setProfile] = useState<ContainerProfile>("modern-0.1");
  const [fileName, setFileName] = useState("untitled.nmdoc");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [searchAssetsLoading, setSearchAssetsLoading] = useState(false);
  const [readingMode, setReadingMode] = useState(loadReadingMode);
  const openInput = useRef<HTMLInputElement>(null);
  const assetsRef = useRef<AssetData[]>([]);
  const searchLoad = useRef<Promise<void> | undefined>(undefined);
  const assetUrls = useAssetUrls(assets);
  const referencedAssets = useMemo(
    () => collectAssetIds(document),
    [document]
  );
  const missingAssets = [...referencedAssets].filter(
    (id) => !assets.some((asset) => asset.id === id)
  );
  const valid = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const theme = normalizeDocumentTheme(document.metadata.theme);
  const accent = normalizeDocumentAccent(document.metadata.accent);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    storeReadingMode(readingMode);
  }, [readingMode]);

  const applySource = (next: string) => {
    setSource(next);
    const result = parse(next);
    setDiagnostics(result.diagnostics);
    if (result.document) setDocument(result.document);
  };

  const replaceAssets = useCallback((next: AssetData[]) => {
    assetsRef.current = next;
    searchLoad.current = undefined;
    setAssets(next);
    setAssetVersion((value) => value + 1);
  }, []);

  const loadAsset = useCallback(async (
    id: string,
    representationIndex?: number,
    purpose: "preview" | "author" | "materialize" = "preview"
  ): Promise<Uint8Array> => {
    const asset = assetsRef.current.find((candidate) => candidate.id === id);
    if (!asset) throw new Error("Unknown asset " + id + ".");
    const {
      assetRepresentations,
      materializeRepresentation,
      selectAssetRepresentationIndex
    } = await import("./core/container");
    const representations = assetRepresentations(asset);
    const selectedIndex =
      representationIndex ?? selectAssetRepresentationIndex(asset);
    const representation = representations[selectedIndex];
    if (!representation) throw new Error("Unknown asset representation.");
    if (representation.data) return representation.data;
    const data = await materializeRepresentation(asset, representation, purpose);
    const current = assetsRef.current.find((candidate) => candidate.id === id);
    const cached = current
      ? cacheRepresentationIfCurrent(
          current,
          selectedIndex,
          representation,
          data
        )
      : undefined;
    if (!cached) {
      throw new Error("Asset representation changed while it was loading.");
    }
    const next = assetsRef.current.map((candidate) =>
      candidate.id === id ? cached : candidate
    );
    assetsRef.current = next;
    setAssets(next);
    setAssetVersion((value) => value + 1);
    return data;
  }, []);

  const addImageAsset = useCallback(async (file: File): Promise<string> => {
    const snapshot = assetsRef.current;
    const asset = await createImageAsset(
      file,
      snapshot.map((candidate) => candidate.id)
    );
    replaceAssets([...snapshot, asset]);
    return asset.id;
  }, [replaceAssets]);

  const loadSearchAssets = useCallback(async (): Promise<void> => {
    if (searchLoad.current) return searchLoad.current;
    const pending = (async () => {
      setSearchAssetsLoading(true);
      try {
        const snapshot = assetsRef.current;
        let budget = 64 * 1024 * 1024;
        const candidates = snapshot.filter((asset) => {
          if (asset.data || !isSearchableMediaType(asset.mediaType)) return false;
          if (asset.bytes > 8 * 1024 * 1024 || asset.bytes > budget) return false;
          budget -= asset.bytes;
          return true;
        });
        if (!candidates.length) return;
        const { materializeAsset } = await import("./core/container");
        const loaded = new Map<string, Uint8Array>();
        for (const asset of candidates) {
          loaded.set(asset.id, await materializeAsset(asset));
        }
        const next = assetsRef.current.map((asset) => {
          const data = loaded.get(asset.id);
          return data && !asset.data ? { ...asset, data } : asset;
        });
        assetsRef.current = next;
        setAssets(next);
        setAssetVersion((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setSearchAssetsLoading(false);
      }
    })();
    searchLoad.current = pending;
    return pending;
  }, []);

  const openFile = useCallback(
    async (file: File, intake: FileIntake = "picker") => {
      setBusy(true);
      setNotice(undefined);
      try {
        const kind = requireNotMarkdownFile(file);
        const origin = intakeLabel(intake);
        if (kind === "package") {
          const { openBrowserPackageFromBlob } = await import("./core/container");
          const opened = await openBrowserPackageFromBlob(file);
          setSource(opened.source);
          setDocument(opened.document);
          setDiagnostics([]);
          replaceAssets(opened.assets);
          setProfile(opened.manifest.containerProfile);
          setFileName(file.name);
          const read = opened.rangeTelemetry?.bytesRead ?? 0;
          const total = opened.rangeTelemetry?.archiveBytes ?? file.size;
          setNotice(
            `${origin} package opened lazily · ${formatBytes(read)} of ${formatBytes(total)} read.`
          );
        } else {
          const text = await file.text();
          const result = parse(text);
          setSource(text);
          setDiagnostics(result.diagnostics);
          if (result.document) setDocument(result.document);
          replaceAssets([]);
          setFileName(file.name.replace(/\.nmt$/i, "") + ".nmdoc");
          setNotice(
            result.document
              ? `${origin} source document opened.`
              : `${origin} source opened with diagnostics.`
          );
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [replaceAssets]
  );

  useEffect(() => {
    const launchQueue = browserLaunchQueue();
    if (!launchQueue) return;
    let active = true;
    launchQueue.setConsumer(async (params) => {
      const handle = params.files[0];
      if (!handle) {
        if (active) {
          setNotice("No document was supplied. Use Open or drag a file here.");
        }
        return;
      }
      try {
        const file = await handle.getFile();
        if (active) await openFile(file, "system");
      } catch (error) {
        if (active) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }
    });
    return () => {
      active = false;
    };
  }, [openFile]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("share-target") !== "1") return;
    let active = true;

    void (async () => {
      try {
        pendingSharedFile ??= takePendingSharedFile();
        const file = await pendingSharedFile;
        if (active) await openFile(file, "share");
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : String(error);
          setNotice(`${message} Use Open or drag a .nmt/.nmdoc file here.`);
        }
      } finally {
        url.searchParams.delete("share-target");
        window.history.replaceState(window.history.state, "", url);
      }
    })();

    return () => {
      active = false;
    };
  }, [openFile]);

  const savePackage = async () => {
    if (!valid || missingAssets.length) return;
    setBusy(true);
    try {
      const targetName = ensureExtension(fileName, ".nmdoc");
      const picker = nativeSavePicker();
      if (picker) {
        const handle = await picker({
          suggestedName: targetName,
          types: [
            {
              description: "NotMarkdown document",
              accept: {
                "application/vnd.notmarkdown.document+zip": [".nmdoc"]
              }
            }
          ]
        });
        const writable = await handle.createWritable();
        const { writeBrowserPackageToSink } = await import("./core/container");
        const telemetry = await writeBrowserPackageToSink(
          { source, assets, profile },
          {
            async write(data) {
              await writable.write(toArrayBuffer(data));
            },
            async close() {
              await writable.close();
            },
            async abort(reason) {
              await writable.abort(reason);
            }
          }
        );
        setNotice(
          `Package streamed locally · ${formatBytes(telemetry.outputBytes)} written.`
        );
      } else {
        const { createBrowserPackage } = await import("./core/container");
        const bytes = await createBrowserPackage({ source, assets, profile });
        download(
          new Blob([toArrayBuffer(bytes)], {
            type: "application/vnd.notmarkdown.document+zip"
          }),
          targetName
        );
        setNotice(
          "Package created locally · compatibility download used."
        );
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const saveSource = () => {
    download(
      new Blob([source], { type: "text/plain;charset=utf-8" }),
      fileName.replace(/\.nmdoc$/i, "") + ".nmt"
    );
  };

  const newDocument = () => {
    applySource(
      [
        "@notmarkdown 0.1",
        "",
        "@document {",
        '  title: "Untitled document"',
        "  language: en",
        "  theme: standard",
        "}",
        "",
        "# Untitled document",
        "",
        "Start writing."
      ].join("\n") + "\n"
    );
    replaceAssets([]);
    setFileName("untitled.nmdoc");
    setActiveView("document");
    setNotice("New local document.");
  };

  const metadataChange = (key: string, value: string) => {
    if (key === "theme" && !valid) return;
    applySource(rewriteMetadata(source, document, key, value));
  };

  const themeChange = (nextTheme: DocumentTheme) => {
    if (valid) metadataChange("theme", nextTheme);
  };

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  return (
    <main
      aria-label="NotMarkdown Studio"
      className={
        "app-shell" +
        (embedded ? " embedded" : "") +
        (dragging ? " dragging" : "")
      }
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void openFile(file, "drop");
      }}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <strong>NotMarkdown</strong>
            <span>Studio</span>
          </div>
        </div>

        <nav className="view-tabs" aria-label="Document views">
          <Tab
            active={activeView === "document"}
            onClick={() => setActiveView("document")}
            icon="▤"
            label="Document"
          />
          <Tab
            active={activeView === "source"}
            onClick={() => setActiveView("source")}
            icon="⌘"
            label="Source"
            badge={diagnostics.length || undefined}
          />
          <Tab
            active={activeView === "package"}
            onClick={() => setActiveView("package")}
            icon="◇"
            label="Package"
            badge={missingAssets.length || undefined}
          />
        </nav>

        <div className="header-actions">
          <button className="quiet-button" onClick={newDocument}>
            New
          </button>
          <button
            className="quiet-button"
            onClick={() => openInput.current?.click()}
          >
            Open
          </button>
          <div className="save-menu">
            <button className="quiet-button" onClick={saveSource}>
              Save source
            </button>
            <button
              className="primary-button"
              disabled={!valid || Boolean(missingAssets.length) || busy}
              onClick={() => void savePackage()}
              title={
                !valid
                  ? "Resolve source diagnostics before packaging"
                  : missingAssets.length
                    ? "Add missing assets before packaging"
                    : "Save one portable document"
              }
            >
              {busy ? "Working…" : "Save .nmdoc"}
            </button>
          </div>
          <input
            ref={openInput}
            hidden
            type="file"
            accept=".nmt,.nmdoc,text/plain,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFile(file, "picker");
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <div className="status-strip">
        <div className="file-identity">
          <span className={"status-dot " + (valid ? "valid" : "invalid")} />
          <input
            aria-label="Document filename"
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
          />
        </div>
        <div className="status-details">
          {!valid && (
            <span className="status-error">
              {diagnostics.length} source{" "}
              {diagnostics.length === 1 ? "diagnostic" : "diagnostics"} · showing
              last valid document
            </span>
          )}
          {missingAssets.length > 0 && (
            <span className="status-warning">
              Missing: {missingAssets.join(", ")}
            </span>
          )}
          <span>Local only</span>
          <FileAccessStatus />
          <span>{profile === "modern-0.1" ? "Zstandard" : "Deflate"}</span>
        </div>
      </div>

      <section className="view-container">
        <Suspense fallback={<ViewLoader />}>
          {activeView === "document" && (
            <DocumentEditor
              document={document}
              documentFingerprint={source}
              assets={assets}
              assetUrls={assetUrls}
              assetVersion={assetVersion}
              searchAssetsLoading={searchAssetsLoading}
              theme={theme}
              accent={accent}
              readingMode={readingMode}
              sourceValid={valid}
              onSearchDemand={loadSearchAssets}
              onLoadAsset={loadAsset}
              onAddImageAsset={addImageAsset}
              onThemeChange={themeChange}
              onReadingModeChange={setReadingMode}
              onChange={applySource}
            />
          )}
          {activeView === "source" && (
            <SourceEditor source={source} onChange={applySource} />
          )}
          {activeView === "package" && (
            <PackageView
              document={document}
              assets={assets}
              assetUrls={assetUrls}
              profile={profile}
              onProfileChange={setProfile}
              onAssetsChange={replaceAssets}
              onLoadAsset={loadAsset}
              onMetadataChange={metadataChange}
            />
          )}
        </Suspense>
      </section>

      {notice && <div className="toast">{notice}</div>}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <span>↓</span>
            <strong>Open a NotMarkdown document</strong>
            <small>.nmt or .nmdoc</small>
          </div>
        </div>
      )}
    </main>
  );
}

type FileIntake = "picker" | "drop" | "system" | "share";

function intakeLabel(intake: FileIntake): string {
  switch (intake) {
    case "drop":
      return "Dropped";
    case "system":
      return "System-launched";
    case "share":
      return "Shared";
    default:
      return "Local";
  }
}

function FileAccessStatus() {
  const systemOpen = Boolean(browserLaunchQueue());
  const nativeSave = Boolean(nativeSavePicker());
  const installed = window.matchMedia?.("(display-mode: standalone)").matches;
  const openLabel = systemOpen
    ? installed
      ? "System open"
      : "Install for system open"
    : "Open: picker + drop";
  const saveLabel = nativeSave ? "native save" : "download save";
  return (
    <span
      className="file-access-status"
      title={`${openLabel}; ${saveLabel}. Files stay on this device.`}
    >
      {openLabel} · {saveLabel}
    </span>
  );
}

interface NativeWritableFile {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface NativeFileHandle {
  createWritable(): Promise<NativeWritableFile>;
}

interface NativeSavePickerOptions {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

function nativeSavePicker():
  | ((options: NativeSavePickerOptions) => Promise<NativeFileHandle>)
  | undefined {
  const picker = (
    window as typeof window & {
      showSaveFilePicker?: (
        options: NativeSavePickerOptions
      ) => Promise<NativeFileHandle>;
    }
  ).showSaveFilePicker;
  return picker?.bind(window);
}

function ViewLoader() {
  return (
    <div className="view-loader">
      <span />
      Loading view…
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon,
  label,
  badge
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  badge?: number;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={active ? "active" : ""}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="tab-label">{label}</span>
      {badge ? <em>{badge}</em> : null}
    </button>
  );
}

function useAssetUrls(assets: readonly AssetData[]) {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const urls = new Map<string, string>();
    for (const asset of assets) {
      if (!asset.data) continue;
      if (!["image", "audio", "video"].includes(asset.kind)) continue;
      urls.set(
        asset.id,
        URL.createObjectURL(
          new Blob([toArrayBuffer(asset.data)], { type: asset.mediaType })
        )
      );
    }
    setUrls(urls);
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [assets]);
  return urls;
}

function cacheRepresentation(
  asset: AssetData,
  representationIndex: number,
  data: Uint8Array
): AssetData {
  const current = asset.representations?.length
    ? [...asset.representations]
    : [
        {
          ...(asset.path ? { path: asset.path } : {}),
          fileName: asset.fileName,
          mediaType: asset.mediaType,
          fingerprint: asset.fingerprint,
          role: asset.role,
          bytes: asset.bytes,
          data: asset.data,
          load: asset.load,
          openStream: asset.openStream
        }
      ];
  const representation = current[representationIndex];
  if (!representation) return asset;
  current[representationIndex] = { ...representation, data };
  const selectedIndex = asset.representations?.findIndex(
    (candidate) =>
      candidate.fingerprint === asset.fingerprint &&
      candidate.fileName === asset.fileName &&
      candidate.mediaType === asset.mediaType
  );
  const selected = current[selectedIndex !== undefined && selectedIndex >= 0 ? selectedIndex : 0]!;
  return { ...asset, ...selected, representations: current };
}

/**
 * Commits deferred bytes only while the exact representation selected before
 * the await is still present at the same index. This prevents a slow range
 * read from overwriting a replacement chosen while that read was in flight.
 */
export function cacheRepresentationIfCurrent(
  asset: AssetData,
  representationIndex: number,
  expected: AssetRepresentationData,
  data: Uint8Array
): AssetData | undefined {
  const current = asset.representations?.length
    ? asset.representations[representationIndex]
    : representationIndex === 0
      ? asset
      : undefined;
  if (!current || !sameRepresentation(current, expected)) return undefined;
  return cacheRepresentation(asset, representationIndex, data);
}

function sameRepresentation(
  current: AssetRepresentationData,
  expected: AssetRepresentationData
): boolean {
  return (
    current.fingerprint === expected.fingerprint &&
    (current.path ?? null) === (expected.path ?? null) &&
    current.fileName === expected.fileName &&
    current.mediaType === expected.mediaType &&
    current.bytes === expected.bytes
  );
}

function isSearchableMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    ["application/json", "application/xml", "image/svg+xml"].includes(
      mediaType
    )
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function rewriteMetadata(
  source: string,
  document: DocumentNode,
  key: string,
  value: string
): string {
  const metadata = { ...document.metadata };
  if (value.trim()) metadata[key] = value;
  else delete metadata[key];

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let cursor = 1;
  while (lines[cursor]?.trim() === "") cursor++;
  if (lines[cursor] === "@document {") {
    cursor++;
    while (cursor < lines.length && lines[cursor] !== "}") cursor++;
    if (lines[cursor] === "}") cursor++;
  }
  while (lines[cursor]?.trim() === "") cursor++;
  const body = lines.slice(cursor).join("\n").replace(/\n+$/, "");
  const header = ["@notmarkdown 0.1", "", "@document {"];
  for (const [field, current] of Object.entries(metadata)) {
    if (current === undefined) continue;
    header.push("  " + field + ": " + metadataScalar(current));
  }
  header.push("}", "", body);
  return header.join("\n").replace(/\n+$/, "") + "\n";
}

function metadataScalar(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_./:+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensureExtension(name: string, extension: string) {
  return name.toLowerCase().endsWith(extension) ? name : name + extension;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function collectAssetIds(document: DocumentNode): Set<string> {
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
