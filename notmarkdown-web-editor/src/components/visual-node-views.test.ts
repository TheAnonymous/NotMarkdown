import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import { editorNodeToSource, editorSchema } from "../core/editor-model";
import { VisualRenderBudget } from "../core/visual-renderers";
import { accessibleChart, visualNodeView } from "./visual-node-views";

describe("static visual node view", () => {
  it("edits Mermaid and Vega-Lite source directly without losing bytes", () => {
    const original = editorSchema.nodes.static_visual.create({
      language: "vegalite",
      source: '{"data":{"values":[]},"mark":"line"}'
    });
    let state = EditorState.create({
      doc: editorSchema.node("doc", undefined, [original])
    });
    const editor = {
      get state() {
        return state;
      },
      dispatch(transaction: ReturnType<typeof state.tr.setNodeMarkup>) {
        state = state.apply(transaction);
      }
    } as unknown as EditorView;
    const budget = new VisualRenderBudget();
    for (let index = 0; index < 32; index++) budget.reserve("used");
    const view = visualNodeView(original, budget, editor, () => 0);
    const textarea = view.dom.querySelector("textarea")!;
    const exact = [
      '{"data":{"values":[{"label":"A","value":1}]},',
      '"mark":"bar","encoding":{"x":{"field":"label"}}}'
    ].join("\n");
    textarea.value = exact;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    expect(state.doc.firstChild?.attrs.language).toBe("vegalite");
    expect(state.doc.firstChild?.attrs.source).toBe(exact);
    const previous = parse("@notmarkdown 0.1\n\nParagraph.\n").document!;
    const serialized = editorNodeToSource(state.doc, previous);
    expect(serialized).toContain("```vegalite\n" + exact + "\n```");
    expect(parse(serialized).document?.children[0]).toMatchObject({
      type: "codeBlock",
      language: "vegalite",
      text: exact
    });
    view.destroy?.();
  });

  it("builds a bounded semantic chart table and encoding summary", () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      category: "row-" + index,
      value: index,
      extra1: index,
      extra2: index,
      extra3: index,
      extra4: index,
      extra5: index,
      extra6: index,
      extra7: index
    }));
    const details = accessibleChart(
      JSON.stringify({
        title: "Latency",
        data: { values: rows },
        mark: "line",
        encoding: {
          x: { field: "category", type: "nominal" },
          y: { field: "value", type: "quantitative" }
        }
      })
    );
    expect(details.querySelector("caption")?.textContent).toContain("first 20 rows");
    expect(details.querySelectorAll("thead th")).toHaveLength(8);
    expect(details.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(details.querySelector("th")?.getAttribute("scope")).toBe("col");
    expect(details.querySelector(".chart-encoding-summary")?.textContent).toContain(
      "x → category (nominal)"
    );
    expect(details.textContent).toContain("source remains complete");
  });
});
