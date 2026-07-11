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
    return sanitizeSvg(rendered.svg);
  });
}

export async function renderVegaLiteSvg(source: string): Promise<string> {
  const preflight = preflightVegaLite(source);
  if (!preflight.ok || !preflight.spec) throw new Error(`${preflight.code}: ${preflight.message}`);
  return queue.run(async () => {
    const [{ compile }, vega] = await Promise.all([import("vega-lite"), import("vega")]);
    const compiled = compile(preflight.spec as never, { config: { background: "transparent" } });
    const view = new vega.View(vega.parse(compiled.spec), { renderer: "none" });
    await view.runAsync();
    const svg = await view.toSVG();
    view.finalize();
    return sanitizeSvg(svg);
  });
}

export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "style", "foreignObject", "iframe", "object", "embed", "a"],
    FORBID_ATTR: ["style", "href", "xlink:href", "onload", "onclick"]
  });
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
