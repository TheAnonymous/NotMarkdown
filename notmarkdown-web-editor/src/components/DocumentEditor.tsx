import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
import type { SelectionBookmark } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  baseKeymap,
  setBlockType,
  toggleMark,
  wrapIn
} from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import {
  IncrementalSearchCache,
  outline,
  searchIndex,
  type DocumentNode
} from "@notmarkdown/reference-toolchain";
import type { AssetData } from "../core/container";
import {
  documentToEditorNode,
  editorNodeToSource,
  editorSchema
} from "../core/editor-model";
import { VisualRenderBudget } from "../core/visual-renderers";
import { visualNodeView } from "./visual-node-views";
import {
  DOCUMENT_THEME_OPTIONS,
  type DocumentAccent,
  type DocumentTheme
} from "../core/document-appearance";
import { validateImageFile } from "../core/image-authoring";

interface Props {
  document: DocumentNode;
  documentFingerprint: string;
  assets: readonly AssetData[];
  assetUrls: ReadonlyMap<string, string>;
  assetVersion: number;
  searchAssetsLoading?: boolean;
  theme?: DocumentTheme;
  accent?: DocumentAccent;
  readingMode?: boolean;
  sourceValid?: boolean;
  onSearchDemand?: () => Promise<void>;
  onLoadAsset?: (id: string) => Promise<Uint8Array>;
  onAddImageAsset?: (file: File) => Promise<string>;
  onThemeChange?: (theme: DocumentTheme) => void;
  onReadingModeChange?: (enabled: boolean) => void;
  onChange: (source: string) => void;
}

export function DocumentEditor({
  document,
  documentFingerprint,
  assets,
  assetUrls,
  assetVersion,
  searchAssetsLoading = false,
  theme = "standard",
  accent = "violet",
  readingMode = false,
  sourceValid = true,
  onSearchDemand,
  onLoadAsset,
  onAddImageAsset,
  onThemeChange,
  onReadingModeChange,
  onChange
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const imageButton = useRef<HTMLButtonElement>(null);
  const imageDialog = useRef<HTMLDialogElement>(null);
  const imageUpload = useRef<HTMLInputElement>(null);
  const imageSelection = useRef<SelectionBookmark | null>(null);
  const editorSelection = useRef<SelectionBookmark | null>(null);
  const searchCache = useRef(new IncrementalSearchCache());
  const [query, setQuery] = useState("");
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [selectedImageId, setSelectedImageId] = useState<string>();
  const [imageFile, setImageFile] = useState<File>();
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>();
  const [imageAlt, setImageAlt] = useState("");
  const [imageDecorative, setImageDecorative] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [imageInserting, setImageInserting] = useState(false);
  const callback = useRef(onChange);
  callback.current = onChange;
  const documentSnapshot = useRef(document);
  documentSnapshot.current = document;
  const outlineEntries = useMemo(() => outline(document), [document]);
  const searchResult = useMemo(() => {
    if (!query.trim()) return undefined;
    const update = searchCache.current.update(
      document,
      documentFingerprint,
      assets.filter((asset) => asset.data).map((asset) => ({
        id: asset.id,
        packagePath: "assets/" + asset.fileName,
        mediaType: asset.mediaType,
        fingerprint: asset.fingerprint,
        data: asset.data!
      }))
    );
    return {
      ...update,
      hits: searchIndex(update.index, query, 30)
    };
  }, [document, documentFingerprint, assets, query]);
  const searchHits = searchResult?.hits ?? [];
  const imageAssets = useMemo(
    () => assets.filter((asset) => asset.kind === "image"),
    [assets]
  );

  useEffect(() => {
    if (query.trim()) void onSearchDemand?.();
  }, [query, onSearchDemand]);

  useEffect(() => {
    if (!imageFile) {
      setImagePreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  useEffect(() => {
    if (!imageDialogOpen) return;
    const dialog = imageDialog.current;
    if (!dialog) return;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // jsdom and older engines expose <dialog> without the modal methods.
        dialog.setAttribute("open", "");
      }
    }
    const firstControl = dialog.querySelector<HTMLElement>(
      'input:not(:disabled), button:not(:disabled), [tabindex="0"]'
    );
    firstControl?.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
    };
  }, [imageDialogOpen]);

  useEffect(() => {
    if (!host.current) return;
    let state = EditorState.create({
      doc: documentToEditorNode(document),
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo
        }),
        keymap(baseKeymap)
      ]
    });
    if (editorSelection.current) {
      try {
        state = state.apply(
          state.tr.setSelection(editorSelection.current.resolve(state.doc))
        );
      } catch {
        editorSelection.current = null;
      }
    }
    const visualBudget = new VisualRenderBudget();
    const view = new EditorView(host.current, {
      state,
      nodeViews: {
        figure: (node) =>
          mediaView(node, "image", assetUrls, assets, onLoadAsset),
        audio: (node) =>
          mediaView(node, "audio", assetUrls, assets, onLoadAsset),
        video: (node) =>
          mediaView(node, "video", assetUrls, assets, onLoadAsset),
        static_visual: (node, editorView, getPos) =>
          visualNodeView(node, visualBudget, editorView, getPos),
        table_of_contents: (node) => tableOfContentsView(node, document)
      },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction);
        view.updateState(next);
        editorSelection.current = next.selection.getBookmark();
        if (transaction.docChanged) {
          callback.current(editorNodeToSource(next.doc, documentSnapshot.current));
        }
      }
    });
    editor.current = view;
    return () => {
      editorSelection.current = view.state.selection.getBookmark();
      view.destroy();
      editor.current = null;
    };
  }, [assetVersion, assetUrls]);

  const command = (action: (view: EditorView) => boolean) => {
    const view = editor.current;
    if (view) {
      action(view);
      view.focus();
    }
  };

  const openImageDialog = () => {
    const view = editor.current;
    if (!sourceValid || !view) return;
    imageSelection.current = view.state.selection.getBookmark();
    editorSelection.current = imageSelection.current;
    setSelectedImageId(undefined);
    setImageFile(undefined);
    setImageAlt("");
    setImageDecorative(false);
    setImageError(undefined);
    setImageInserting(false);
    setImageDialogOpen(true);
  };

  const closeImageDialog = (force = false) => {
    if (imageInserting && !force) return;
    setImageDialogOpen(false);
    setSelectedImageId(undefined);
    setImageFile(undefined);
    setImageAlt("");
    setImageDecorative(false);
    setImageError(undefined);
    window.setTimeout(() => imageButton.current?.focus(), 0);
  };

  const chooseExistingImage = (id: string) => {
    setSelectedImageId(id);
    setImageFile(undefined);
    setImageError(undefined);
    if (imageUpload.current) imageUpload.current.value = "";
  };

  const chooseImageFile = (file: File | undefined) => {
    if (!file) return;
    try {
      validateImageFile(file);
      setImageFile(file);
      setSelectedImageId(undefined);
      setImageError(undefined);
    } catch (error) {
      setImageFile(undefined);
      setSelectedImageId(undefined);
      setImageError(error instanceof Error ? error.message : String(error));
      if (imageUpload.current) imageUpload.current.value = "";
    }
  };

  const insertImage = async () => {
    const alt = imageAlt.trim();
    if (
      imageInserting ||
      !sourceValid ||
      (!selectedImageId && !imageFile) ||
      (!imageDecorative && !alt)
    ) {
      return;
    }
    setImageInserting(true);
    setImageError(undefined);
    try {
      let assetId = selectedImageId;
      if (imageFile) {
        if (!onAddImageAsset) {
          throw new Error("Image upload is not available.");
        }
        assetId = await onAddImageAsset(imageFile);
      } else if (assetId) {
        const asset = imageAssets.find((candidate) => candidate.id === assetId);
        if (!asset) throw new Error("The selected image is no longer available.");
        if (!asset.data) {
          if (!onLoadAsset) throw new Error("The selected image could not be loaded.");
          await onLoadAsset(assetId);
        }
      }
      const view = editor.current;
      if (!view || !assetId) throw new Error("The image could not be inserted.");
      let selection = view.state.selection;
      try {
        selection = imageSelection.current?.resolve(view.state.doc) ?? selection;
      } catch {
        // Keep the current safe selection if the document changed unexpectedly.
      }
      const node = editorSchema.nodes.figure.create({
        assetId,
        alt: imageDecorative ? "" : alt,
        layout: "normal",
        decorative: imageDecorative
      });
      view.dispatch(
        view.state.tr
          .setSelection(selection)
          .replaceSelectionWith(node)
          .scrollIntoView()
      );
      closeImageDialog(true);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageInserting(false);
    }
  };

  const jumpToPath = (path: string) => {
    const match = /^\/children\/(\d+)/.exec(path);
    const view = editor.current;
    if (!match || !view) return;
    const childIndex = Number(match[1]);
    if (childIndex >= view.state.doc.childCount) return;
    let position = 0;
    for (let index = 0; index < childIndex; index++) {
      position += view.state.doc.child(index).nodeSize;
    }
    const selection = TextSelection.near(
      view.state.doc.resolve(Math.min(position + 1, view.state.doc.content.size))
    );
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    view.focus();
  };

  return (
    <div
      className="document-workspace"
      data-theme={theme}
      data-accent={accent}
      data-reading-mode={readingMode ? "dyslexia" : "default"}
    >
      <div className="format-toolbar" role="toolbar" aria-label="Formatting">
        <button
          title="Paragraph"
          onClick={() =>
            command((view) =>
              setBlockType(editorSchema.nodes.paragraph)(
                view.state,
                view.dispatch
              )
            )
          }
        >
          ¶
        </button>
        <button
          title="Heading"
          onClick={() =>
            command((view) =>
              setBlockType(editorSchema.nodes.heading, { level: 2 })(
                view.state,
                view.dispatch
              )
            )
          }
        >
          H2
        </button>
        <span className="toolbar-rule" />
        <button
          title="Strong"
          onClick={() =>
            command((view) =>
              toggleMark(editorSchema.marks.strong)(view.state, view.dispatch)
            )
          }
        >
          <strong>B</strong>
        </button>
        <button
          title="Emphasis"
          onClick={() =>
            command((view) =>
              toggleMark(editorSchema.marks.em)(view.state, view.dispatch)
            )
          }
        >
          <em>I</em>
        </button>
        <button
          title="Inline code"
          onClick={() =>
            command((view) =>
              toggleMark(editorSchema.marks.code)(view.state, view.dispatch)
            )
          }
        >
          {"</>"}
        </button>
        <span className="toolbar-rule" />
        <button
          title="Bullet list"
          onClick={() =>
            command((view) =>
              wrapInList(editorSchema.nodes.bullet_list)(
                view.state,
                view.dispatch
              )
            )
          }
        >
          • List
        </button>
        <button
          title="Numbered list"
          onClick={() =>
            command((view) =>
              wrapInList(editorSchema.nodes.ordered_list)(
                view.state,
                view.dispatch
              )
            )
          }
        >
          1. List
        </button>
        <button
          title="Quote"
          onClick={() =>
            command((view) =>
              wrapIn(editorSchema.nodes.blockquote)(view.state, view.dispatch)
            )
          }
        >
          “”
        </button>
        <span className="toolbar-rule" />
        <button
          ref={imageButton}
          type="button"
          title={
            sourceValid
              ? "Insert image"
              : "Resolve source diagnostics before inserting an image"
          }
          disabled={!sourceValid}
          onClick={openImageDialog}
        >
          Image
        </button>
        <button
          title="Insert Mermaid diagram"
          onClick={() => command((view) => {
            const node = editorSchema.nodes.static_visual.create({
              language: "mermaid",
              source: "flowchart LR\n  Source --> Package --> Verify"
            });
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
            return true;
          })}
        >
          Diagram
        </button>
        <button
          title="Insert Vega-Lite chart"
          onClick={() => command((view) => {
            const node = editorSchema.nodes.static_visual.create({
              language: "vega-lite",
              source: JSON.stringify({
                data: { values: [{ label: "A", value: 1 }, { label: "B", value: 2 }] },
                mark: "bar",
                encoding: {
                  x: { field: "label", type: "nominal" },
                  y: { field: "value", type: "quantitative" }
                }
              }, null, 2)
            });
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
            return true;
          })}
        >
          Chart
        </button>
        <span className="toolbar-spacer" />
        <label className="toolbar-theme-control">
          <span>Theme</span>
          <select
            value={theme}
            disabled={!sourceValid}
            title={
              sourceValid
                ? "Document theme"
                : "Resolve source diagnostics before changing the document theme"
            }
            onChange={(event) =>
              onThemeChange?.(event.target.value as DocumentTheme)
            }
          >
            {DOCUMENT_THEME_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="reading-mode-toggle"
          type="button"
          aria-pressed={readingMode}
          title="Personal reading aid; does not change the document"
          onClick={() => onReadingModeChange?.(!readingMode)}
        >
          Dyslexia-friendly
        </button>
        <span className="toolbar-rule" />
        <button title="Undo" onClick={() => command((view) => undo(view.state, view.dispatch))}>
          ↶
        </button>
        <button title="Redo" onClick={() => command((view) => redo(view.state, view.dispatch))}>
          ↷
        </button>
      </div>
      {imageDialogOpen && (
        <dialog
          ref={imageDialog}
          className="image-dialog"
          aria-labelledby="image-dialog-title"
          aria-modal="true"
          onCancel={(event) => {
            event.preventDefault();
            closeImageDialog();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeImageDialog();
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeImageDialog();
          }}
        >
          <form
            method="dialog"
            className="image-dialog-panel"
            aria-busy={imageInserting}
            onSubmit={(event) => {
              event.preventDefault();
              void insertImage();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="image-dialog-header">
              <div>
                <span className="eyebrow">Document image</span>
                <h2 id="image-dialog-title">Insert image</h2>
              </div>
              <button
                type="button"
                className="image-dialog-close"
                aria-label="Close image dialog"
                disabled={imageInserting}
                onClick={() => closeImageDialog()}
              >
                ×
              </button>
            </header>

            <div className="image-dialog-body">
              <fieldset className="image-source-section">
                <legend>Existing images</legend>
                {imageAssets.length ? (
                  <div className="image-asset-options">
                    {imageAssets.map((asset) => {
                      const preview = assetUrls.get(asset.id);
                      return (
                        <label
                          className={
                            "image-asset-option" +
                            (selectedImageId === asset.id ? " selected" : "")
                          }
                          key={asset.id}
                        >
                          <input
                            type="radio"
                            name="image-source"
                            value={asset.id}
                            checked={selectedImageId === asset.id}
                            disabled={imageInserting}
                            onChange={() => chooseExistingImage(asset.id)}
                          />
                          {preview ? (
                            <img src={preview} alt={`Preview of asset:${asset.id}`} />
                          ) : (
                            <span className="image-preview-placeholder" aria-hidden="true">
                              ▧
                            </span>
                          )}
                          <span>
                            <strong>asset:{asset.id}</strong>
                            <small>{asset.fileName}</small>
                            {!preview && <small>Preview loads on insert</small>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="image-dialog-empty">No image assets in this package.</p>
                )}
              </fieldset>

              <fieldset className="image-source-section">
                <legend>Upload image</legend>
                <label className="image-upload-control">
                  <span>Choose a local image</span>
                  <input
                    ref={imageUpload}
                    type="file"
                    accept="image/*"
                    disabled={imageInserting}
                    onChange={(event) => chooseImageFile(event.target.files?.[0])}
                  />
                </label>
                {imageFile && imagePreviewUrl && (
                  <div className="image-upload-preview">
                    <img src={imagePreviewUrl} alt={`Preview of ${imageFile.name}`} />
                    <span>{imageFile.name}</span>
                  </div>
                )}
              </fieldset>

              <fieldset className="image-description-section">
                <legend>Image description</legend>
                <label>
                  <span>Alt text</span>
                  <input
                    type="text"
                    value={imageAlt}
                    disabled={imageDecorative || imageInserting}
                    aria-describedby="image-alt-help"
                    onChange={(event) => setImageAlt(event.target.value)}
                  />
                </label>
                <label className="decorative-option">
                  <input
                    type="checkbox"
                    checked={imageDecorative}
                    disabled={imageInserting}
                    onChange={(event) => setImageDecorative(event.target.checked)}
                  />
                  <span>Decorative</span>
                </label>
                <small id="image-alt-help">
                  Describe the image’s purpose, or explicitly mark it as decorative.
                </small>
              </fieldset>

              {imageError && (
                <div className="image-dialog-error" role="alert">
                  {imageError}
                </div>
              )}
            </div>

            <footer className="image-dialog-footer">
              <button
                type="button"
                className="quiet-button"
                disabled={imageInserting}
                onClick={() => closeImageDialog()}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  !sourceValid ||
                  imageInserting ||
                  (!selectedImageId && !imageFile) ||
                  (!imageDecorative && !imageAlt.trim())
                }
              >
                {imageInserting ? "Inserting…" : "Insert"}
              </button>
            </footer>
          </form>
        </dialog>
      )}
      <div className="document-main">
        <aside className="document-navigation" aria-label="Document navigation">
          <label htmlFor="document-search">Search document and embedded text</label>
          <input
            id="document-search"
            type="search"
            value={query}
            placeholder="Headings, transcripts, captions…"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.trim() ? (
            <div className="navigation-results" aria-live="polite">
              <span>{searchHits.length} results</span>
              {searchResult && (
                <small className="search-origin">
                  Cache {searchResult.stats.assetsReused} reused ·{" "}
                  {searchResult.stats.assetsReindexed} rebuilt
                </small>
              )}
              {searchAssetsLoading && (
                <small className="search-origin">Loading embedded text…</small>
              )}
              {searchHits.map((hit) => (
                <button
                  key={[hit.path, hit.assetId, hit.packagePath].join(":")}
                  onClick={() => jumpToPath(hit.path)}
                >
                  <strong>{hit.section ?? hit.kind}</strong>
                  {hit.assetId && (
                    <small className="search-origin">
                      {hit.kind} · asset:{hit.assetId}
                    </small>
                  )}
                  <small>{hit.context}</small>
                </button>
              ))}
              {searchHits.length === 0 && !searchAssetsLoading && (
                <p>No matching document or embedded text.</p>
              )}
              {(searchResult?.index.omissions.length ?? 0) > 0 && (
                <p>{searchResult?.index.omissions.length} text asset(s) omitted safely.</p>
              )}
            </div>
          ) : (
            <nav className="navigation-outline" aria-label="Automatic outline">
              <span>Contents</span>
              {outlineEntries.map((entry) => (
                <button
                  key={entry.path}
                  style={{ paddingInlineStart: 10 + (entry.level - 1) * 13 }}
                  onClick={() => jumpToPath(entry.path)}
                >
                  {entry.title}
                </button>
              ))}
              {outlineEntries.length === 0 && <p>Add headings to build the outline.</p>}
            </nav>
          )}
        </aside>
        <div
          aria-label="Editable document canvas"
          className="document-scroll"
          tabIndex={0}
        >
          <div
            className="document-paper"
            ref={host}
            onClick={() => {
              const view = editor.current;
              if (view && !view.hasFocus()) {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.near(view.state.doc.resolve(1))
                  )
                );
                view.focus();
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

function tableOfContentsView(node: ProseMirrorNode, document: DocumentNode) {
  const dom = window.document.createElement("nav");
  dom.className = "nmd-toc rendered";
  dom.contentEditable = "false";
  const title = window.document.createElement("strong");
  title.textContent = "Contents";
  dom.append(title);
  const list = window.document.createElement("ol");
  const maxDepth = node.attrs.maxDepth as number | null;
  for (const entry of outline(document)) {
    if (maxDepth !== null && entry.level > maxDepth) continue;
    const item = window.document.createElement("li");
    item.style.marginInlineStart = String((entry.level - 1) * 18) + "px";
    item.textContent = entry.title;
    list.append(item);
  }
  dom.append(list);
  return { dom };
}

function mediaView(
  node: ProseMirrorNode,
  kind: "image" | "audio" | "video",
  assetUrls: ReadonlyMap<string, string>,
  assets: readonly AssetData[],
  onLoadAsset?: (id: string) => Promise<Uint8Array>
) {
  const dom = document.createElement("figure");
  dom.className = "nmd-media-node rendered";
  dom.contentEditable = "false";
  const url = assetUrls.get(node.attrs.assetId);

  if (url && kind === "image") {
    const image = document.createElement("img");
    image.src = url;
    image.alt = node.attrs.alt ?? "";
    dom.append(image);
  } else if (url && kind === "audio") {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    dom.append(audio);
  } else if (url && kind === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.preload = "metadata";
    dom.append(video);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "media-placeholder";
    const available = assets.some((asset) => asset.id === node.attrs.assetId);
    if (available && onLoadAsset) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Load ${kind} · asset:${node.attrs.assetId}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        button.disabled = true;
        button.textContent = `Loading ${kind}…`;
        void onLoadAsset(node.attrs.assetId).catch((error: unknown) => {
          button.disabled = false;
          button.textContent =
            error instanceof Error ? error.message : `Could not load ${kind}`;
        });
      });
      placeholder.append(button);
    } else {
      placeholder.textContent = "Missing asset: " + node.attrs.assetId;
    }
    dom.append(placeholder);
  }

  if (!(kind === "image" && node.attrs.decorative)) {
    const caption = document.createElement("figcaption");
    caption.textContent =
      node.attrs.alt || node.attrs.label || "asset:" + node.attrs.assetId;
    dom.append(caption);
  }
  return { dom };
}
