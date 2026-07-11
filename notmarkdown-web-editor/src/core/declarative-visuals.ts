export type VisualNotation = "mermaid" | "vega-lite" | "vegalite";

export const MAX_VISUAL_BYTES = 256 * 1024;
export const MAX_VISUAL_LINES = 10_000;
const MAX_VEGA_VALUES = 5_000;
const MAX_VEGA_FIELDS = 64;

export interface VisualPreflight {
  ok: boolean;
  code?: string;
  message?: string;
  spec?: Record<string, unknown>;
}

export function visualNotation(language: string | undefined): VisualNotation | undefined {
  return language === "mermaid" || language === "vega-lite" || language === "vegalite"
    ? language
    : undefined;
}

export function preflightMermaid(source: string): VisualPreflight {
  const bounded = preflightBounds(source);
  if (!bounded.ok) return bounded;
  const forbidden: Array<[RegExp, string]> = [
    [/%%\s*\{/i, "Mermaid configuration directives are not allowed."],
    [/\b(?:click|href|callback|call|link)\b/i, "Mermaid interactions and links are not allowed."],
    [/<\s*\/?\s*(?:script|style|iframe|object|embed|foreignObject|img|image|a)\b/i, "Active markup is not allowed."],
    [/!\[[^\]]*\]\s*\([^)]*\)/, "Markdown image resources are not allowed."],
    [/\[[^\]]+\]\s*\(\s*(?:https?:|data:|blob:|\/|\.\.?(?:\/|\\))/i, "Markdown links and relative resources are not allowed."],
    [/\b(?:img|icon|sprite|image)\s*[:=(]/i, "Image resources are not allowed."],
    [/(?:url|image|image-set)\s*\(/i, "CSS resources are not allowed."],
    [/@(?:import|font-face)\b/i, "Imported styles and fonts are not allowed."],
    [/(?:https?:|file:|data:|blob:|javascript:|\/\/)/i, "External resources are not allowed."],
    [/(?:^|[\s"'(])\.\.?[\\/][^\s"')]+/m, "Relative resources are not allowed."]
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(source)) return { ok: false, code: "NMD-E104", message };
  }
  return { ok: true };
}

export function preflightVegaLite(
  source: string,
  chartType?: "bar" | "line" | "area" | "scatter" | "pie"
): VisualPreflight {
  const bounded = preflightBounds(source);
  if (!bounded.ok) return bounded;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, code: "NMD-E105", message: "Vega-Lite source must be valid JSON." };
  }
  if (!isRecord(value)) return rejectVega("The chart specification must be a JSON object.");

  const allowedTop = new Set(["$schema", "title", "description", "data", "mark", "encoding", "width", "height"]);
  if (Object.keys(value).some((key) => !allowedTop.has(key))) {
    return rejectVega("Only a bounded single-view Vega-Lite subset is supported.");
  }
  if (value.$schema !== undefined && (typeof value.$schema !== "string" || !/^https:\/\/vega\.github\.io\/schema\/vega-lite\/v[0-9.]+\.json$/.test(value.$schema))) {
    return rejectVega("The optional schema identifier is not a Vega-Lite schema URL.");
  }
  if ((value.title !== undefined && typeof value.title !== "string") ||
      (value.description !== undefined && typeof value.description !== "string")) {
    return rejectVega("Chart title and description must be plain strings.");
  }
  for (const dimension of [value.width, value.height]) {
    if (dimension !== undefined && (!Number.isInteger(dimension) || Number(dimension) < 16 || Number(dimension) > 1600)) {
      return rejectVega("Chart width and height must be integers from 16 through 1600.");
    }
  }
  if (!isRecord(value.data) || Object.keys(value.data).length !== 1 || !Array.isArray(value.data.values)) {
    return rejectVega("Chart data must use an embedded data.values array.");
  }
  if (value.data.values.length > MAX_VEGA_VALUES) return rejectVega("The chart contains too many rows.");
  for (const row of value.data.values) {
    if (!isRecord(row) || Object.keys(row).length > MAX_VEGA_FIELDS || Object.values(row).some((cell) => !isScalar(cell))) {
      return rejectVega("Chart rows must be flat objects containing scalar values.");
    }
  }

  const marks = new Set(["bar", "line", "area", "point", "circle", "arc"]);
  if (typeof value.mark !== "string" || !marks.has(value.mark)) return rejectVega("The chart mark is not supported.");
  if (chartType && !markMatches(chartType, value.mark)) return rejectVega("The chart type and Vega-Lite mark do not agree.");
  if (!isRecord(value.encoding) || !validateEncoding(value.encoding)) {
    return rejectVega("The chart encoding contains unsupported channels or properties.");
  }
  return { ok: true, spec: value };
}

function preflightBounds(source: string): VisualPreflight {
  if (source.length > MAX_VISUAL_BYTES) {
    return { ok: false, code: "NMD-E104", message: "Visual source exceeds 256 KiB." };
  }
  if (new TextEncoder().encode(source).byteLength > MAX_VISUAL_BYTES) {
    return { ok: false, code: "NMD-E104", message: "Visual source exceeds 256 KiB." };
  }
  if (source.split("\n").length > MAX_VISUAL_LINES) {
    return { ok: false, code: "NMD-E104", message: "Visual source exceeds 10,000 lines." };
  }
  return { ok: true };
}

function validateEncoding(encoding: Record<string, unknown>): boolean {
  const channels = new Set(["x", "y", "color", "size", "shape", "theta", "radius", "detail", "order"]);
  const keys = new Set(["field", "type", "title", "aggregate", "stack", "sort"]);
  const types = new Set(["quantitative", "temporal", "ordinal", "nominal"]);
  const aggregates = new Set(["count", "sum", "mean", "median", "min", "max"]);
  for (const [channel, definition] of Object.entries(encoding)) {
    if (!channels.has(channel) || !isRecord(definition)) return false;
    if (Object.keys(definition).some((key) => !keys.has(key))) return false;
    if (typeof definition.field !== "string" || definition.field.length > 200) return false;
    if (typeof definition.type !== "string" || !types.has(definition.type)) return false;
    if (definition.title !== undefined && typeof definition.title !== "string") return false;
    if (definition.aggregate !== undefined && (typeof definition.aggregate !== "string" || !aggregates.has(definition.aggregate))) return false;
    if (definition.stack !== undefined && definition.stack !== "zero" && definition.stack !== "normalize" && definition.stack !== null) return false;
    if (definition.sort !== undefined && definition.sort !== null) return false;
  }
  return Object.keys(encoding).length > 0;
}

function markMatches(chartType: string, mark: string): boolean {
  return chartType === "bar" ? mark === "bar" :
    chartType === "line" ? mark === "line" :
      chartType === "area" ? mark === "area" :
        chartType === "scatter" ? mark === "point" || mark === "circle" :
          chartType === "pie" && mark === "arc";
}

function rejectVega(message: string): VisualPreflight {
  return { ok: false, code: "NMD-E105", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
