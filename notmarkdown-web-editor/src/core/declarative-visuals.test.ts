import { describe, expect, it } from "vitest";
import { preflightMermaid, preflightVegaLite, visualNotation } from "./declarative-visuals";

describe("static declarative visuals", () => {
  it("recognizes only exact lowercase fence names", () => {
    expect(visualNotation("mermaid")).toBe("mermaid");
    expect(visualNotation("vega-lite")).toBe("vega-lite");
    expect(visualNotation("vegalite")).toBe("vegalite");
    expect(visualNotation("Mermaid")).toBeUndefined();
    expect(visualNotation("vl")).toBeUndefined();
  });

  it("accepts inert Mermaid and rejects resource and interaction vectors", () => {
    expect(preflightMermaid("flowchart LR\n  A --> B").ok).toBe(true);
    for (const source of [
      "flowchart LR\n  click A https://example.com",
      "flowchart LR\n  A[![x](./secret.png)]",
      "flowchart LR\n  A[<img src='./secret.png'>]",
      "%%{init: {'theme':'dark'}}%%\nflowchart LR\nA-->B",
      "flowchart LR\n  A[icon(./local.svg)]"
    ]) expect(preflightMermaid(source).ok).toBe(false);
  });

  it("accepts a bounded values-only Vega-Lite chart", () => {
    const source = JSON.stringify({
      data: { values: [{ label: "A", value: 1 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "nominal", sort: null },
        y: { field: "value", type: "quantitative" }
      }
    });
    expect(preflightVegaLite(source, "bar").ok).toBe(true);
  });

  it("rejects remote data, expressions, formats, transforms, and mark mismatches", () => {
    const base = { data: { values: [{ x: 1, y: 2 }] }, mark: "bar", encoding: { x: { field: "x", type: "quantitative" } } };
    expect(preflightVegaLite(JSON.stringify({ ...base, data: { url: "https://example.com/data.json" } })).ok).toBe(false);
    expect(preflightVegaLite(JSON.stringify({ ...base, transform: [{ calculate: "1e9", as: "x" }] })).ok).toBe(false);
    expect(preflightVegaLite(JSON.stringify({ ...base, encoding: { x: { field: "x", type: "quantitative", axis: { labelExpr: "datum" } } } })).ok).toBe(false);
    expect(preflightVegaLite(JSON.stringify({ ...base, encoding: { x: { field: "x", type: "quantitative", sort: "ascending" } } })).ok).toBe(false);
    expect(preflightVegaLite(JSON.stringify(base), "line").ok).toBe(false);
  });
});
