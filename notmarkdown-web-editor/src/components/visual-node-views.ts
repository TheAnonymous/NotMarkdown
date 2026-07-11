import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { NodeView, EditorView } from "prosemirror-view";
import { preflightMermaid, preflightVegaLite } from "../core/declarative-visuals";
import {
  renderMermaidSvg,
  renderVegaLiteSvg,
  VisualRenderBudget
} from "../core/visual-renderers";

export function visualNodeView(
  node: ProseMirrorNode,
  budget: VisualRenderBudget,
  editor?: EditorView,
  getPos?: () => number | undefined
): NodeView {
  let language = String(node.attrs.language);
  let source = String(node.attrs.source);
  let objectUrl: string | undefined;
  let generation = 0;

  const dom = document.createElement("figure");
  dom.className = "nmd-static-visual rendered";
  dom.contentEditable = "false";

  const header = document.createElement("figcaption");
  const updateHeader = () => {
    header.textContent =
      language === "mermaid" ? "Mermaid diagram" : "Vega-Lite chart";
  };
  updateHeader();
  dom.append(header);

  const output = document.createElement("div");
  output.className = "static-visual-output";
  output.setAttribute("aria-live", "polite");
  dom.append(output);

  const accessible = document.createElement("div");
  accessible.className = "static-visual-accessible";
  dom.append(accessible);

  const sourceView = document.createElement("details");
  sourceView.className = "static-visual-source";
  const summary = document.createElement("summary");
  summary.textContent = "Edit source";
  const sourceEditor = document.createElement("textarea");
  sourceEditor.value = source;
  sourceEditor.spellcheck = false;
  sourceEditor.setAttribute(
    "aria-label",
    language === "mermaid" ? "Mermaid source" : "Vega-Lite source"
  );
  const renderButton = document.createElement("button");
  renderButton.type = "button";
  renderButton.textContent = "Update preview";
  sourceView.append(summary, sourceEditor, renderButton);
  dom.append(sourceView);

  const revoke = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };

  const markStale = () => {
    generation += 1;
    revoke();
    accessible.replaceChildren();
    output.replaceChildren(status("Source changed. Update the static preview."));
  };

  const render = async () => {
    const requestedGeneration = ++generation;
    revoke();
    const requestedLanguage = language;
    const requestedSource = source;
    output.replaceChildren(status("Rendering static preview…"));
    accessible.replaceChildren();
    const preflight =
      requestedLanguage === "mermaid"
        ? preflightMermaid(requestedSource)
        : preflightVegaLite(requestedSource);
    if (!preflight.ok) {
      output.replaceChildren(error(`${preflight.code}: ${preflight.message}`));
      return;
    }
    if (requestedLanguage !== "mermaid") {
      accessible.replaceChildren(accessibleChart(requestedSource));
    }
    try {
      const svg =
        requestedLanguage === "mermaid"
          ? await renderMermaidSvg(requestedSource)
          : await renderVegaLiteSvg(requestedSource);
      if (requestedGeneration !== generation) return;
      revoke();
      objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const image = document.createElement("img");
      image.src = objectUrl;
      image.alt =
        requestedLanguage === "mermaid"
          ? "Rendered Mermaid diagram"
          : "Rendered Vega-Lite chart; an accessible data table follows";
      output.replaceChildren(image);
    } catch (reason) {
      if (requestedGeneration !== generation) return;
      output.replaceChildren(
        error(reason instanceof Error ? reason.message : String(reason))
      );
    }
  };

  sourceEditor.addEventListener("input", () => {
    source = sourceEditor.value;
    markStale();
    const position = getPos?.();
    if (editor && typeof position === "number") {
      editor.dispatch(
        editor.state.tr.setNodeMarkup(position, undefined, { language, source })
      );
    }
  });
  renderButton.addEventListener("click", () => void render());

  if (budget.reserve(source)) void render();
  else {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Render preview";
    button.addEventListener("click", () => void render(), { once: true });
    output.append(status("Automatic render budget reached. "), button);
  }

  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      const nextLanguage = String(next.attrs.language);
      const nextSource = String(next.attrs.source);
      language = nextLanguage;
      updateHeader();
      sourceEditor.setAttribute(
        "aria-label",
        language === "mermaid" ? "Mermaid source" : "Vega-Lite source"
      );
      if (source !== nextSource) {
        source = nextSource;
        if (document.activeElement !== sourceEditor) sourceEditor.value = source;
        markStale();
      }
      return true;
    },
    stopEvent(event) {
      return dom.contains(event.target as globalThis.Node);
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      generation += 1;
      revoke();
    }
  };
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

export function accessibleChart(source: string): HTMLElement {
  const details = document.createElement("details");
  details.className = "chart-data-summary";
  details.open = false;
  const summary = document.createElement("summary");
  summary.textContent = "Accessible chart data";
  details.append(summary);
  try {
    const spec = JSON.parse(source) as {
      title?: string;
      description?: string;
      data?: { values?: Array<Record<string, unknown>> };
      encoding?: Record<string, { field?: unknown; type?: unknown }>;
    };
    const rows = spec.data?.values ?? [];
    const allColumns = [
      ...new Set(rows.flatMap((row) => Object.keys(row)))
    ].sort();
    const columns = allColumns.slice(0, 8);
    const description = document.createElement("p");
    description.className = "chart-encoding-summary";
    const encodings = Object.entries(spec.encoding ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([channel, definition]) => {
        const field = scalarText(definition.field);
        const type = scalarText(definition.type);
        return `${channel} → ${field || "derived"}${type ? ` (${type})` : ""}`;
      });
    description.textContent = [
      spec.title || spec.description || "Chart",
      encodings.length ? "Encoding: " + encodings.join("; ") : ""
    ]
      .filter(Boolean)
      .join(". ");
    details.append(description);

    if (!columns.length) {
      details.append(status("The chart contains no tabular rows."));
      return details;
    }
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = `Chart data${rows.length > 20 ? ", first 20 rows" : ""}`;
    table.append(caption);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column;
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const row of rows.slice(0, 20)) {
      const line = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = scalarText(row[column]).slice(0, 200);
        line.append(cell);
      }
      body.append(line);
    }
    table.append(body);
    details.append(table);
    if (rows.length > 20 || columns.length < allColumns.length) {
      details.append(
        status(
          `Table truncated to ${Math.min(rows.length, 20)} rows and ${columns.length} columns; source remains complete.`
        )
      );
    }
  } catch {
    details.append(error("Chart data is unavailable."));
  }
  return details;
}

function scalarText(value: unknown): string {
  return value === null || value === undefined
    ? ""
    : typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ? String(value)
      : "[structured value]";
}
