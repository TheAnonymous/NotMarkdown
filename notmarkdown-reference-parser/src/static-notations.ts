export type StaticNotationLanguage = "mermaid" | "vega-lite" | "vegalite";
export type StaticNotation = "mermaid" | "vega-lite";

export type StaticNotationIssueCode =
  | "NMD_STATIC_NOTATION_BYTES_LIMIT"
  | "NMD_STATIC_NOTATION_LINES_LIMIT"
  | "NMD_STATIC_NOTATION_DEPTH_LIMIT"
  | "NMD_STATIC_NOTATION_NODES_LIMIT"
  | "NMD_MERMAID_CONFIG_FORBIDDEN"
  | "NMD_MERMAID_INTERACTION_FORBIDDEN"
  | "NMD_MERMAID_RESOURCE_FORBIDDEN"
  | "NMD_MERMAID_MARKUP_FORBIDDEN"
  | "NMD_VEGA_JSON_INVALID"
  | "NMD_VEGA_ROOT_INVALID"
  | "NMD_VEGA_CONFIG_FORBIDDEN"
  | "NMD_VEGA_INTERACTION_FORBIDDEN"
  | "NMD_VEGA_RESOURCE_FORBIDDEN"
  | "NMD_VEGA_EXPRESSION_FORBIDDEN";

export interface StaticNotationIssue {
  code: StaticNotationIssueCode;
  message: string;
  path?: string;
}

export interface StaticNotationLimits {
  maxBytes?: number;
  maxLines?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export interface StaticNotationInspection {
  language: StaticNotationLanguage;
  notation: StaticNotation;
  renderable: boolean;
  bytes: number;
  lines: number;
  nodes?: number;
  maxDepth?: number;
  issues: StaticNotationIssue[];
}

export const DEFAULT_STATIC_NOTATION_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxLines: 10_000,
  maxDepth: 64,
  maxNodes: 10_000
});

/** Maps only the three canonical, case-sensitive fence identifiers. */
export function staticNotationForLanguage(
  language: string
): StaticNotation | undefined {
  if (language === "mermaid") return "mermaid";
  if (language === "vega-lite" || language === "vegalite") {
    return "vega-lite";
  }
  return undefined;
}

/**
 * Performs the renderer preflight without rendering or fetching anything.
 * Unknown (including differently-cased) fence languages deliberately return
 * undefined and continue to behave as ordinary code blocks.
 */
export function inspectStaticNotationFence(
  language: string,
  source: string,
  limits: StaticNotationLimits = {}
): StaticNotationInspection | undefined {
  const notation = staticNotationForLanguage(language);
  if (!notation) return undefined;

  const resolved = {
    maxBytes: limits.maxBytes ?? DEFAULT_STATIC_NOTATION_LIMITS.maxBytes,
    maxLines: limits.maxLines ?? DEFAULT_STATIC_NOTATION_LIMITS.maxLines,
    maxDepth: limits.maxDepth ?? DEFAULT_STATIC_NOTATION_LIMITS.maxDepth,
    maxNodes: limits.maxNodes ?? DEFAULT_STATIC_NOTATION_LIMITS.maxNodes
  };
  const bytes = Buffer.byteLength(source, "utf8");
  let lines = source === "" ? 0 : 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  const issues: StaticNotationIssue[] = [];

  if (bytes > resolved.maxBytes) {
    issues.push({
      code: "NMD_STATIC_NOTATION_BYTES_LIMIT",
      message: `Static notation source exceeds the ${resolved.maxBytes}-byte preview limit.`
    });
  }
  if (lines > resolved.maxLines) {
    issues.push({
      code: "NMD_STATIC_NOTATION_LINES_LIMIT",
      message: `Static notation source exceeds the ${resolved.maxLines}-line preview limit.`
    });
  }

  let complexity: { nodes?: number; maxDepth?: number } = {};
  if (!issues.length) {
    complexity =
      notation === "mermaid"
        ? inspectMermaid(source, issues)
        : inspectVegaLite(source, resolved, issues);
  }

  return {
    language: language as StaticNotationLanguage,
    notation,
    renderable: issues.length === 0,
    bytes,
    lines,
    ...complexity,
    issues
  };
}

function inspectMermaid(
  source: string,
  issues: StaticNotationIssue[]
): Record<string, never> {
  addRegexIssue(
    source,
    /%%\s*\{|^---[\s\S]*?^\s*(?:config|securityLevel|themeCSS|fontFamily)\s*:|\b(?:securityLevel|htmlLabels|themeCSS)\b/imu,
    issues,
    "NMD_MERMAID_CONFIG_FORBIDDEN",
    "Mermaid configuration and init directives are disabled for static previews."
  );
  addRegexIssue(
    source,
    /^\s*(?:click|href|link)\b|\b(?:callback|call)\s*\(|\btarget\s*=\s*["']/imu,
    issues,
    "NMD_MERMAID_INTERACTION_FORBIDDEN",
    "Mermaid links, callbacks, and interaction directives are disabled."
  );
  addRegexIssue(
    source,
    /<\s*(?:img|image|use)\b|\b(?:img|icon|sprite)\s*:|(?:url|image|image-set)\s*\(|@(?:import|font-face)\b|!\[[^\]]*\]\s*\([^)]*\)|\[[^\]]+\]\s*\((?:https?:|\/|\.|#)[^)]*\)/imu,
    issues,
    "NMD_MERMAID_RESOURCE_FORBIDDEN",
    "Mermaid previews cannot reference images, fonts, URLs, or other resources."
  );
  addRegexIssue(
    source,
    /<\s*\/?\s*(?:script|style|iframe|object|embed|foreignObject|form|input|button|video|audio|svg)\b/imu,
    issues,
    "NMD_MERMAID_MARKUP_FORBIDDEN",
    "Active HTML and SVG markup is disabled in Mermaid previews."
  );
  return {};
}

function inspectVegaLite(
  source: string,
  limits: Required<StaticNotationLimits>,
  issues: StaticNotationIssue[]
): { nodes?: number; maxDepth?: number } {
  let root: unknown;
  try {
    root = JSON.parse(source) as unknown;
  } catch {
    issues.push({
      code: "NMD_VEGA_JSON_INVALID",
      message: "Vega-Lite preview source must be valid JSON."
    });
    return {};
  }
  if (!isRecord(root)) {
    issues.push({
      code: "NMD_VEGA_ROOT_INVALID",
      message: "A Vega-Lite preview must have a JSON object at its root.",
      path: ""
    });
    return { nodes: 1, maxDepth: 0 };
  }

  const stack: Array<{ value: unknown; depth: number; path: string }> = [
    { value: root, depth: 0, path: "" }
  ];
  let nodes = 0;
  let maxDepth = 0;
  let depthReported = false;
  let nodesReported = false;
  const categories = new Set<StaticNotationIssueCode>();

  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    maxDepth = Math.max(maxDepth, current.depth);
    if (nodes > limits.maxNodes) {
      if (!nodesReported) {
        issues.push({
          code: "NMD_STATIC_NOTATION_NODES_LIMIT",
          message: `Vega-Lite source exceeds the ${limits.maxNodes}-node preview limit.`,
          path: current.path
        });
        nodesReported = true;
      }
      break;
    }
    if (current.depth > limits.maxDepth) {
      if (!depthReported) {
        issues.push({
          code: "NMD_STATIC_NOTATION_DEPTH_LIMIT",
          message: `Vega-Lite source exceeds the nesting-depth limit of ${limits.maxDepth}.`,
          path: current.path
        });
        depthReported = true;
      }
      continue;
    }

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          depth: current.depth + 1,
          path: current.path + "/" + index
        });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;

    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!;
      const path = current.path + "/" + escapePointer(key);
      const lower = key.toLowerCase();
      if (lower === "config") {
        addCategory(
          categories,
          issues,
          "NMD_VEGA_CONFIG_FORBIDDEN",
          "Vega-Lite config blocks are disabled for deterministic previews.",
          path
        );
      } else if (
        lower === "params" ||
        lower === "bind" ||
        lower === "selection" ||
        lower === "href" ||
        lower === "cursor" ||
        lower === "tooltip"
      ) {
        addCategory(
          categories,
          issues,
          "NMD_VEGA_INTERACTION_FORBIDDEN",
          "Vega-Lite parameters, selections, links, and interactions are disabled.",
          path
        );
      } else if (
        lower === "url" ||
        lower === "image" ||
        lower === "font" ||
        lower === "fonturl"
      ) {
        addCategory(
          categories,
          issues,
          "NMD_VEGA_RESOURCE_FORBIDDEN",
          "Vega-Lite previews must use embedded values and cannot load resources.",
          path
        );
      } else if (lower === "expr" || lower.endsWith("expr")) {
        addCategory(
          categories,
          issues,
          "NMD_VEGA_EXPRESSION_FORBIDDEN",
          "Vega and Vega-Lite expressions are disabled in static previews.",
          path
        );
      }
      stack.push({ value, depth: current.depth + 1, path });
    }
  }
  return { nodes, maxDepth };
}

function addRegexIssue(
  source: string,
  pattern: RegExp,
  issues: StaticNotationIssue[],
  code: StaticNotationIssueCode,
  message: string
): void {
  if (pattern.test(source)) issues.push({ code, message });
}

function addCategory(
  seen: Set<StaticNotationIssueCode>,
  issues: StaticNotationIssue[],
  code: StaticNotationIssueCode,
  message: string,
  path: string
): void {
  if (seen.has(code)) return;
  seen.add(code);
  issues.push({ code, message, path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
