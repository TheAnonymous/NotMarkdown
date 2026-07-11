import DOMPurify from "dompurify";
import { preflightMermaid, preflightVegaLite } from "./declarative-visuals";

const RENDER_TIMEOUT_MS = 4_000;
let mermaidSequence = 0;

class RenderQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await withTimeout(job(), RENDER_TIMEOUT_MS);
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class VisualRenderBudget {
  private count = 0;
  private bytes = 0;

  reserve(source: string): boolean {
    if (source.length > 1024 * 1024) return false;
    const bytes = new TextEncoder().encode(source).byteLength;
    if (this.count >= 32 || this.bytes + bytes > 1024 * 1024) return false;
    this.count += 1;
    this.bytes += bytes;
    return true;
  }
}

const queue = new RenderQueue(2);

export async function renderMermaidSvg(source: string): Promise<string> {
  const preflight = preflightMermaid(source);
  if (!preflight.ok) throw new Error(`${preflight.code}: ${preflight.message}`);
  return queue.run(async () => {
    const module = await import("mermaid");
    const mermaid = module.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      htmlLabels: false,
      flowchart: { htmlLabels: false }
    });
    const rendered = await mermaid.render(`notmarkdown-visual-${++mermaidSequence}`, source);
    return sanitizeMermaidSvg(rendered.svg);
  });
}

export async function renderVegaLiteSvg(source: string): Promise<string> {
  const preflight = preflightVegaLite(source);
  if (!preflight.ok || !preflight.spec) throw new Error(`${preflight.code}: ${preflight.message}`);
  return queue.run(async () => {
    const [{ compile }, vega, { expressionInterpreter }] = await Promise.all([
      import("vega-lite"),
      import("vega"),
      import("vega-interpreter")
    ]);
    const compiled = compile(preflight.spec as never, { config: { background: "transparent" } });
    const runtime = vega.parse(compiled.spec, undefined, { ast: true });
    const view = new vega.View(runtime, {
      expr: expressionInterpreter,
      renderer: "none"
    });
    await view.runAsync();
    const svg = await view.toSVG();
    view.finalize();
    return sanitizeSvg(svg);
  });
}

export function sanitizeSvg(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "style", "foreignObject", "iframe", "object", "embed", "a"],
    FORBID_ATTR: ["style", "href", "xlink:href", "onload", "onclick"]
  });
  return removeExternalSvgReferences(sanitized);
}

export function sanitizeMermaidSvg(svg: string): string {
  const sanitized = sanitizeSvg(svg);
  const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    return sanitized;
  }

  setSvgAttributes(root, "svg", {
    "font-family": "trebuchet ms, verdana, arial, sans-serif",
    "font-size": "16px"
  });
  setSvgAttributes(root, "text, tspan", { fill: "#000000" });
  setSvgAttributes(root, ".label text", { "text-anchor": "middle" });
  setSvgAttributes(
    root,
    ".node rect, .node circle, .node ellipse, .node polygon, .node path",
    { fill: "#eee", stroke: "#999", "stroke-width": "1px" }
  );
  setSvgAttributes(root, ".flowchart-link", {
    fill: "none",
    stroke: "#666",
    "stroke-width": "1px"
  });
  setSvgAttributes(root, ".edge-pattern-dashed", {
    "stroke-dasharray": "3"
  });
  setSvgAttributes(root, ".edge-pattern-dotted", {
    "stroke-dasharray": "2"
  });
  setSvgAttributes(root, "marker.marker, marker.marker path, marker.marker polygon, marker.marker circle", {
    fill: "#666",
    stroke: "#666"
  });
  setSvgAttributes(root, ".edgeLabel .background", {
    fill: "#ffffff",
    "fill-opacity": "0.8"
  });
  setSvgAttributes(root, ".cluster rect", {
    fill: "#f5f5f5",
    stroke: "#707070",
    "stroke-width": "1px"
  });

  return sanitizeSvg(new XMLSerializer().serializeToString(root));
}

function setSvgAttributes(
  root: Element,
  selector: string,
  attributes: Record<string, string>
): void {
  const elements = root.matches(selector)
    ? [root, ...root.querySelectorAll(selector)]
    : [...root.querySelectorAll(selector)];
  for (const element of elements) {
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
  }
}

const SVG_RESOURCE_ATTRIBUTES = [
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end"
] as const;

function removeExternalSvgReferences(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) return "";
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const name of SVG_RESOURCE_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && hasExternalCssUrl(value)) element.removeAttribute(name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

function hasExternalCssUrl(value: string): boolean {
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(match[2]!.trim())) return true;
  }
  return false;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Static visual rendering timed out.")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
