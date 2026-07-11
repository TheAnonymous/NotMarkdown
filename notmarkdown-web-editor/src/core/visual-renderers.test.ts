import { describe, expect, it } from "vitest";
import { sanitizeSvg, VisualRenderBudget } from "./visual-renderers";

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
});
