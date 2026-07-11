import { describe, expect, it } from "vitest";
import {
  renderMermaidSvg,
  renderVegaLiteSvg,
  sanitizeSvg,
  VisualRenderBudget
} from "./visual-renderers";

describe("visual rendering boundary", () => {
  it("removes active and document-global SVG content", () => {
    const sanitized = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrow"><path d="M0,0L10,5L0,10z"/></marker>
        <clipPath id="clip"><rect width="10" height="10"/></clipPath>
      </defs>
      <style>@import url(https://evil.test/theme.css); body{display:none}</style>
      <script>alert(1)</script>
      <foreignObject><p>active</p></foreignObject>
      <a href="https://evil.test/"><text>link</text></a>
      <rect id="remote" style="fill:red" onload="alert(1)" width="10" height="10"
        fill="url(https://evil.test/fill)" stroke="url('https://evil.test/stroke')"
        filter="url(https://evil.test/filter)" mask="url(https://evil.test/mask)"
        clip-path="url(https://evil.test/clip)" marker-start="url(https://evil.test/start)"
        marker-mid="url(https://evil.test/mid)" marker-end="url(https://evil.test/end)"/>
      <path id="local" d="M0,0L10,10" marker-end="url(#arrow)" clip-path="url(#clip)"/>
    </svg>`);
    expect(sanitized).not.toContain("<style");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("<foreignObject");
    expect(sanitized).not.toContain("<a");
    expect(sanitized).not.toContain("style=");
    expect(sanitized).not.toContain("onload=");
    const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
    const remote = parsed.getElementById("remote");
    expect(remote).not.toBeNull();
    for (const attribute of [
      "fill",
      "stroke",
      "filter",
      "mask",
      "clip-path",
      "marker-start",
      "marker-mid",
      "marker-end"
    ]) expect(remote?.getAttribute(attribute)).toBeNull();
    expect(parsed.getElementById("local")?.getAttribute("marker-end")).toBe(
      "url(#arrow)"
    );
    expect(parsed.getElementById("local")?.getAttribute("clip-path")).toBe(
      "url(#clip)"
    );
  });

  it("bounds automatic rendering per document", () => {
    const budget = new VisualRenderBudget();
    for (let index = 0; index < 32; index++) expect(budget.reserve("A-->B")).toBe(true);
    expect(budget.reserve("A-->B")).toBe(false);
  });

  it("keeps a sanitized Mermaid flowchart readable without returned CSS", async () => {
    const computedTextLength = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getComputedTextLength"
    );
    const boundingBox = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getBBox"
    );
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value() {
        return (this.textContent ?? "").length * 8;
      }
    });
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value() {
        const width = Math.max(20, (this.textContent ?? "").length * 8);
        return {
          x: 0,
          y: 0,
          width,
          height: 20,
          top: 0,
          right: width,
          bottom: 20,
          left: 0,
          toJSON: () => ({})
        };
      }
    });
    try {
      const svg = await renderMermaidSvg([
        "flowchart LR",
        "  Draft[Draft] --> Inspect[Inspect source] --> Build[Build package] --> Verify[Verify and share]"
      ].join("\n"));
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(parsed.querySelector("parsererror")).toBeNull();
      const nodes = [...parsed.querySelectorAll(".node > rect.label-container")];
      expect(nodes).toHaveLength(4);
      for (const node of nodes) {
        expect(node.getAttribute("fill")).toBe("#eee");
        expect(node.getAttribute("stroke")).toBe("#999");
        expect(node.getAttribute("stroke-width")).toBe("1px");
      }
      const labels = [...parsed.querySelectorAll(".node .label text")];
      expect(labels.map((label) => label.textContent)).toEqual([
        "Draft",
        "Inspect source",
        "Build package",
        "Verify and share"
      ]);
      for (const label of labels) {
        expect(label.getAttribute("fill")).toBe("#000000");
        expect(label.getAttribute("text-anchor")).toBe("middle");
      }
      const links = [...parsed.querySelectorAll("path.flowchart-link")];
      expect(links).toHaveLength(3);
      for (const link of links) {
        expect(link.getAttribute("fill")).toBe("none");
        expect(link.getAttribute("stroke")).toBe("#666");
        expect(link.getAttribute("stroke-width")).toBe("1px");
        expect(link.getAttribute("marker-end")).toMatch(
          /^url\(#[A-Za-z0-9_.:-]+\)$/
        );
      }
      for (const marker of parsed.querySelectorAll("marker.marker")) {
        expect(marker.getAttribute("fill")).toBe("#666");
        expect(marker.getAttribute("stroke")).toBe("#666");
      }
      expect(
        parsed.querySelector(
          "style, script, foreignObject, iframe, object, embed, a, [style], [href]"
        )
      ).toBeNull();
    } finally {
      restoreProperty(
        SVGElement.prototype,
        "getComputedTextLength",
        computedTextLength
      );
      restoreProperty(SVGElement.prototype, "getBBox", boundingBox);
    }
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
      const chart = {
        data: { values: [{ label: "A", value: 1 }, { label: "B", value: 2 }] },
        mark: "bar",
        encoding: {
          x: { field: "label", type: "nominal", sort: null },
          y: { field: "value", type: "quantitative" }
        }
      };
      const svg = await renderVegaLiteSvg(JSON.stringify(chart));
      expect(svg).toContain("<svg");
      expect(svg).toContain("aria-roledescription=\"bar\"");
      const defaultSize = svgSize(svg);
      expect(defaultSize.width).toBeGreaterThanOrEqual(500);
      expect(defaultSize.width).toBeGreaterThan(defaultSize.height);

      const explicitlySized = await renderVegaLiteSvg(JSON.stringify({
        ...chart,
        width: 240,
        height: 160
      }));
      const explicitSize = svgSize(explicitlySized);
      expect(explicitSize.width).toBeLessThan(defaultSize.width - 150);
      expect(explicitSize.height).toBeLessThan(defaultSize.height - 50);
    } finally {
      globalThis.Function = NativeFunction;
      HTMLCanvasElement.prototype.getContext = nativeGetContext;
    }
  });
});

function svgSize(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  return {
    width: Number(root.getAttribute("width")),
    height: Number(root.getAttribute("height"))
  };
}

function restoreProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}
