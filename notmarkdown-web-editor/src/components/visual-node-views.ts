import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { preflightMermaid, preflightVegaLite } from "../core/declarative-visuals";
import { renderMermaidSvg, renderVegaLiteSvg, VisualRenderBudget } from "../core/visual-renderers";

export function visualNodeView(node: ProseMirrorNode, budget: VisualRenderBudget): NodeView {
  const language = String(node.attrs.language);
  const source = String(node.attrs.source);
  const dom = document.createElement("figure");
  dom.className = "nmd-static-visual rendered";
  dom.contentEditable = "false";

  const header = document.createElement("figcaption");
  header.textContent = language === "mermaid" ? "Mermaid diagram" : "Vega-Lite chart";
  dom.append(header);

  const output = document.createElement("div");
  output.className = "static-visual-output";
  dom.append(output);

  const sourceView = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Source";
  const pre = document.createElement("pre");
  pre.textContent = source;
  sourceView.append(summary, pre);
  dom.append(sourceView);

  let objectUrl: string | undefined;
  const revoke = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };

  const render = async () => {
    output.replaceChildren(status("Rendering static preview…"));
    const preflight = language === "mermaid" ? preflightMermaid(source) : preflightVegaLite(source);
    if (!preflight.ok) {
      output.replaceChildren(error(`${preflight.code}: ${preflight.message}`));
      return;
    }
    try {
      const svg = language === "mermaid" ? await renderMermaidSvg(source) : await renderVegaLiteSvg(source);
      revoke();
      objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const image = document.createElement("img");
      image.src = objectUrl;
      image.alt = language === "mermaid" ? "Rendered Mermaid diagram" : "Rendered Vega-Lite chart";
      output.replaceChildren(image);
      if (language !== "mermaid") dom.append(accessibleTable(source));
    } catch (reason) {
      output.replaceChildren(error(reason instanceof Error ? reason.message : String(reason)));
    }
  };

  if (budget.reserve(source)) void render();
  else {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Render preview";
    button.addEventListener("click", () => void render(), { once: true });
    output.append(status("Automatic render budget reached. "), button);
  }

  return { dom, destroy: revoke };
}

function status(message: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "visual-status";
  element.textContent = message;
  return element;
}

function error(message: string): HTMLElement {
  const element = status(message);
  element.classList.add("visual-error");
  return element;
}

function accessibleTable(source: string): HTMLElement {
  const details = document.createElement("details");
  details.className = "chart-data-summary";
  const summary = document.createElement("summary");
  summary.textContent = "Accessible chart data";
  details.append(summary);
  try {
    const spec = JSON.parse(source) as { data?: { values?: Array<Record<string, unknown>> }; encoding?: Record<string, unknown> };
    const rows = spec.data?.values ?? [];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort().slice(0, 8);
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const column of columns) { const cell = document.createElement("th"); cell.textContent = column; head.append(cell); }
    table.append(head);
    for (const row of rows.slice(0, 20)) {
      const line = document.createElement("tr");
      for (const column of columns) { const cell = document.createElement("td"); cell.textContent = String(row[column] ?? ""); line.append(cell); }
      table.append(line);
    }
    details.append(table);
    if (rows.length > 20 || columns.length < [...new Set(rows.flatMap((row) => Object.keys(row)))].length) {
      details.append(status("Table truncated for preview; source remains complete."));
    }
  } catch {
    details.append(error("Chart data is unavailable."));
  }
  return details;
}
