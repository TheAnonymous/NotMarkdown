import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate
} from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { linter, lintGutter } from "@codemirror/lint";
import { parse } from "@notmarkdown/reference-toolchain/parser";

interface Props {
  source: string;
  onChange: (source: string) => void;
}

export function SourceEditor({ source, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source,
        extensions: [
          basicSetup,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          lintGutter(),
          syntaxDecorations,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callback.current(update.state.doc.toString());
          }),
          linter(
            (current) => {
              const result = parse(current.state.doc.toString());
              return result.diagnostics.map((item) => ({
                from: Math.min(item.range.start.offset, current.state.doc.length),
                to: Math.min(
                  Math.max(item.range.end.offset, item.range.start.offset + 1),
                  current.state.doc.length
                ),
                severity: "error",
                message: item.code + ": " + item.message
              }));
            },
            { delay: 180 }
          ),
          EditorView.theme({
            "&": {
              height: "100%",
              fontSize: "14px",
              background: "#11131a",
              color: "#e8eaf2"
            },
            ".cm-content": {
              fontFamily:
                '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
              padding: "24px 0",
              caretColor: "#b8abff"
            },
            ".cm-gutters": {
              background: "#11131a",
              color: "#64697b",
              border: "none"
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              background: "rgba(109, 93, 252, 0.09)"
            },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              background: "rgba(109, 93, 252, 0.34)"
            }
          })
        ]
      })
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === source) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: source }
    });
  }, [source]);

  return <div className="source-editor" ref={host} />;
}

const syntaxDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

function decorate(view: EditorView): DecorationSet {
  const decorations = [];
  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      const text = line.text;
      if (/^#{1,6} /.test(text)) {
        decorations.push(
          Decoration.mark({ class: "cm-nmd-heading" }).range(line.from, line.to)
        );
      } else if (/^!/.test(text)) {
        decorations.push(
          Decoration.mark({ class: "cm-nmd-directive" }).range(line.from, line.to)
        );
      } else if (/^(@notmarkdown|@document)/.test(text)) {
        decorations.push(
          Decoration.mark({ class: "cm-nmd-metadata" }).range(line.from, line.to)
        );
      } else if (/^(\s*)(-|\d+\.) /.test(text)) {
        const marker = /^(\s*)(-|\d+\.)/.exec(text);
        if (marker) {
          decorations.push(
            Decoration.mark({ class: "cm-nmd-list" }).range(
              line.from + marker[1]!.length,
              line.from + marker[0].length
            )
          );
        }
      }
      position = line.to + 1;
      if (position > view.state.doc.length) break;
    }
  }
  return Decoration.set(decorations, true);
}
