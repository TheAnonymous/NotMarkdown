import { describe, expect, it } from "vitest";
import {
  renderVegaLiteSvg,
  sanitizeSvg,
  VisualRenderBudget
} from "./visual-renderers";

describe("visual rendering boundary", () => {
  it("removes active and document-global SVG content", () => {
    const sanitized = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>body{display:none}</style><script>alert(1)</script><rect style="fill:red" width="10" height="10"/></svg>`);
    expect(sanitized).not.toContain("<style");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("style=");
    expect(sanitized).toContain("<svg");
  });

  it("bounds automatic rendering per document", () => {
    const budget = new VisualRenderBudget();
    for (let index = 0; index < 32; index++) expect(budget.reserve("A-->B")).toBe(true);
    expect(budget.reserve("A-->B")).toBe(false);
  });

  it("renders Vega-Lite through the CSP-safe expression interpreter", async () => {
    const NativeFunction = globalThis.Function;
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    globalThis.Function = (() => {
      throw new Error("Dynamic JavaScript evaluation is disabled by CSP.");
    }) as unknown as FunctionConstructor;
    HTMLCanvasElement.prototype.getContext = (() => ({
      measureText: (value: string) => ({ width: value.length * 6 })
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      const svg = await renderVegaLiteSvg(JSON.stringify({
        data: { values: [{ label: "A", value: 1 }, { label: "B", value: 2 }] },
        mark: "bar",
        encoding: {
          x: { field: "label", type: "nominal" },
          y: { field: "value", type: "quantitative" }
        }
      }));
      expect(svg).toContain("<svg");
      expect(svg).toContain("aria-roledescription=\"bar\"");
    } finally {
      globalThis.Function = NativeFunction;
      HTMLCanvasElement.prototype.getContext = nativeGetContext;
    }
  });
});
