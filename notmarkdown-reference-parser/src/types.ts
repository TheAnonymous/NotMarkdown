export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  range: SourceRange;
  suggestion?: string;
}

export interface ParseOptions {
  sourceName?: string;
}

export interface ParseResult {
  document?: DocumentNode;
  diagnostics: Diagnostic[];
}

export type Reference =
  | { kind: "internal"; id: string }
  | { kind: "asset"; id: string }
  | { kind: "external"; uri: string };

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "emphasis"; children: InlineNode[] }
  | { type: "strong"; children: InlineNode[] }
  | { type: "code"; text: string }
  | { type: "link"; target: Reference; children: InlineNode[] }
  | {
      type: "image";
      resource: Reference;
      alt: string;
      decorative?: true;
      attributes?: LayoutAttributes;
    }
  | { type: "hardBreak" }
  | { type: "footnoteReference"; target: string }
  | {
      type: "crossReference";
      target: { kind: "internal"; id: string };
      children: InlineNode[];
    }
  | { type: "mathInline"; source: string; notation: "tex" };

export interface LayoutAttributes {
  layout?: "inline" | "normal" | "wide" | "full" | "gallery";
}

export interface MediaAttributes {
  layout?: "normal" | "wide" | "full";
  poster?: { kind: "asset"; id: string };
  transcript?: { kind: "asset"; id: string };
  chapters?: { kind: "asset"; id: string };
  start?: string;
  captions?: Record<string, { kind: "asset"; id: string }>;
}

export type BlockNode =
  | { type: "paragraph"; id?: string; children: InlineNode[] }
  | { type: "heading"; id?: string; level: number; children: InlineNode[] }
  | { type: "thematicBreak"; id?: string }
  | { type: "tableOfContents"; id?: string; maxDepth?: number }
  | { type: "blockQuote"; id?: string; children: BlockNode[] }
  | { type: "list"; id?: string; ordered: boolean; start?: number; children: ListItemNode[] }
  | { type: "codeBlock"; id?: string; text: string; language?: string }
  | {
      type: "callout";
      id?: string;
      kind: "note" | "tip" | "warning" | "danger";
      children: BlockNode[];
    }
  | FigureNode
  | AudioNode
  | VideoNode
  | {
      type: "diagram";
      id?: string;
      diagramType: "flow" | "sequence" | "architecture";
      source: Reference;
      children: BlockNode[];
    }
  | {
      type: "chart";
      id?: string;
      chartType: "bar" | "line" | "area" | "scatter" | "pie";
      data: Reference;
      children: BlockNode[];
    }
  | { type: "mathBlock"; id?: string; source: string; notation: "tex" | "asciimath" }
  | {
      type: "attachment";
      id?: string;
      resource: Reference;
      label: InlineNode[];
      children: BlockNode[];
    };

export interface ListItemNode {
  type: "listItem";
  id?: string;
  checked?: boolean;
  children: BlockNode[];
}

export interface FigureNode {
  type: "figure";
  id?: string;
  resource: Reference;
  alt: string;
  decorative?: true;
  attributes?: LayoutAttributes;
  children: BlockNode[];
}

export interface AudioNode {
  type: "audio";
  id?: string;
  resource: Reference;
  label: InlineNode[];
  attributes?: MediaAttributes;
  children: BlockNode[];
}

export interface VideoNode {
  type: "video";
  id?: string;
  resource: Reference;
  label: InlineNode[];
  attributes?: MediaAttributes;
  children: BlockNode[];
}

export type DocumentTheme =
  | "standard"
  | "paper"
  | "technical"
  | "minimal"
  | "sepia"
  | "midnight"
  | "high-contrast";

export interface DocumentMetadata {
  title?: string;
  language?: string;
  theme?: DocumentTheme;
  accent?: "blue" | "green" | "orange" | "violet" | "neutral";
  density?: "compact" | "comfortable";
  [namespacedKey: string]: unknown;
}

export interface DocumentNode {
  type: "document";
  modelVersion: "0.1";
  metadata: DocumentMetadata;
  children: BlockNode[];
  definitions: {
    footnotes: Record<string, BlockNode[]>;
    citations: Record<string, Record<string, unknown>>;
    extensions: Record<string, unknown>;
  };
}
