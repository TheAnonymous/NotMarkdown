import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
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

interface Props {
  document: DocumentNode;
  documentFingerprint: string;
  assets: readonly AssetData[];
  assetUrls: ReadonlyMap<string, string>;
  assetVersion: number;
  searchAssetsLoading?: boolean;
  onSearchDemand?: () => Promise<void>;
  onLoadAsset?: (id: string) => Promise<Uint8Array>;
  onChange: (source: string) => void;
}

export function DocumentEditor({
  document,
  documentFingerprint,
  assets,
  assetUrls,
  assetVersion,
  searchAssetsLoading = false,
  onSearchDemand,
  onLoadAsset,
  onChange
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const searchCache = useRef(new IncrementalSearchCache());
  const [query, setQuery] = useState("");
  const callback = useRef(onChange);
  callback.current = onChange;
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

  useEffect(() => {
    if (query.trim()) void onSearchDemand?.();
  }, [query, onSearchDemand]);

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
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
        if (transaction.docChanged) {
          callback.current(editorNodeToSource(next.doc, document));
        }
      }
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [assetVersion]);

  const command = (action: (view: EditorView) => boolean) => {
    const view = editor.current;
    if (view) {
      action(view);
      view.focus();
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
    <div className="document-workspace">
      <div className="format-toolbar" aria-label="Formatting">
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
        <button title="Undo" onClick={() => command((view) => undo(view.state, view.dispatch))}>
          ↶
        </button>
        <button title="Redo" onClick={() => command((view) => redo(view.state, view.dispatch))}>
          ↷
        </button>
      </div>
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

  const caption = document.createElement("figcaption");
  caption.textContent =
    node.attrs.alt || node.attrs.label || "asset:" + node.attrs.assetId;
  dom.append(caption);
  return { dom };
}
