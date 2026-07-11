import type {
  BlockNode,
  Diagnostic,
  DocumentMetadata,
  DocumentNode,
  FigureNode,
  InlineNode,
  ListItemNode,
  MediaAttributes,
  ParseOptions,
  ParseResult,
  Reference,
  SourceRange
} from "./types.js";
import { inspectStaticNotationFence } from "./static-notations.js";

const GRAVE = String.fromCharCode(96);
const ID = /^[A-Za-z][A-Za-z0-9._-]*$/;
const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const NS = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

interface Line {
  text: string;
  number: number;
  offset: number;
}

interface MapResult {
  values: Record<string, unknown>;
  next: number;
}

class Parser {
  private lines: Line[];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly ids = new Set<string>();
  private readonly internalRefs: Array<{ id: string; line: Line }> = [];
  private readonly footnoteRefs: Array<{ id: string; line: Line }> = [];
  private readonly footnotes: Record<string, BlockNode[]> = {};

  constructor(source: string, private readonly options: ParseOptions) {
    this.lines = makeLines(source);
  }

  run(): ParseResult {
    const first = this.lines[0];
    if (!first || first.text !== "@notmarkdown 0.1") {
      this.addError(
        "NMD_HEADER_REQUIRED",
        "The first line must be exactly @notmarkdown 0.1.",
        first ?? { text: "", number: 1, offset: 0 },
        1,
        1,
        "Add @notmarkdown 0.1 as the first line."
      );
      return { diagnostics: this.diagnostics };
    }

    let index = 1;
    while (this.blank(index)) index++;

    let metadata: DocumentMetadata = {};
    if (this.lines[index]?.text === "@document {") {
      const mapped = this.parseMap(index, "@document");
      metadata = this.metadataFrom(mapped.values, this.lines[index]!);
      index = mapped.next;
    }

    const children = this.parseBlocks(index, this.lines.length);
    this.resolveReferences();

    const document: DocumentNode = {
      type: "document",
      modelVersion: "0.1",
      metadata,
      children,
      definitions: {
        footnotes: this.footnotes,
        citations: {},
        extensions: {}
      }
    };

    return this.diagnostics.some((item) => item.severity === "error")
      ? { diagnostics: this.diagnostics }
      : { document, diagnostics: this.diagnostics };
  }

  private parseBlocks(start: number, end: number): BlockNode[] {
    const nodes: BlockNode[] = [];
    let index = start;

    while (index < end) {
      const line = this.lines[index]!;
      if (line.text.trim() === "") {
        index++;
        continue;
      }

      if (line.text.startsWith(GRAVE.repeat(3))) {
        const parsed = this.codeBlock(index, end);
        if (parsed.node) nodes.push(parsed.node);
        index = parsed.next;
        continue;
      }

      const heading = /^(#{1,6}) +(.+)$/.exec(line.text);
      if (heading) {
        let text = heading[2]!;
        let id: string | undefined;
        const anchored = /^(.*?)[ ]+\{#([^}]+)\}$/.exec(text);
        if (anchored) {
          text = anchored[1]!;
          id = this.registerId(anchored[2]!, line);
        }
        const node: BlockNode = {
          type: "heading",
          level: heading[1]!.length,
          children: this.inline(text, line)
        };
        if (id) node.id = id;
        nodes.push(node);
        index++;
        continue;
      }

      if (line.text === "---") {
        nodes.push({ type: "thematicBreak" });
        index++;
        continue;
      }

      if (/^>($| )/.test(line.text)) {
        const selected: Line[] = [];
        while (index < end && /^>($| )/.test(this.lines[index]!.text)) {
          const current = this.lines[index]!;
          selected.push({
            ...current,
            text: current.text === ">" ? "" : current.text.slice(2)
          });
          index++;
        }
        nodes.push({
          type: "blockQuote",
          children: this.withLines(selected, () =>
            this.parseBlocks(0, selected.length)
          )
        });
        continue;
      }

      const list = /^(-|\d+\.) +(.*)$/.exec(line.text);
      if (list) {
        const parsed = this.list(index, end, list[1] !== "-");
        nodes.push(parsed.node);
        index = parsed.next;
        continue;
      }

      const footnote = /^\[\^([A-Za-z][A-Za-z0-9._-]*)\]: +(.*)$/.exec(
        line.text
      );
      if (footnote) {
        const id = footnote[1]!;
        if (Object.hasOwn(this.footnotes, id)) {
          this.addError(
            "NMD_FOOTNOTE_DUPLICATE",
            "Footnote " + id + " is defined more than once.",
            line
          );
        } else {
          this.footnotes[id] = [
            { type: "paragraph", children: this.inline(footnote[2]!, line) }
          ];
        }
        index++;
        continue;
      }

      if (line.text.startsWith("!")) {
        const directive = this.directive(index);
        if (directive) {
          if (directive.node) nodes.push(directive.node);
          index = directive.next;
          continue;
        }
      }

      if (/^ +/.test(line.text)) {
        this.addError(
          "NMD_INDENT_UNEXPECTED",
          "Unexpected indentation outside a container.",
          line
        );
      }

      const paragraph: Line[] = [];
      while (
        index < end &&
        this.lines[index]!.text.trim() !== "" &&
        (paragraph.length === 0 || !this.blockStart(this.lines[index]!.text))
      ) {
        paragraph.push(this.lines[index]!);
        index++;
      }
      const content = paragraph.map((item) => item.text).join("\n");
      nodes.push({
        type: "paragraph",
        children: this.inline(content, paragraph[0] ?? line)
      });
    }
    return nodes;
  }

  private codeBlock(
    start: number,
    end: number
  ): { node?: BlockNode; next: number } {
    const opening = this.lines[start]!;
    const fence = GRAVE.repeat(3);
    const language = opening.text.slice(3);
    if (language && !/^[A-Za-z0-9][A-Za-z0-9_+.-]*$/.test(language)) {
      this.addError(
        "NMD_CODE_LANGUAGE_INVALID",
        "Invalid code fence language identifier.",
        opening
      );
    }
    const content: string[] = [];
    let index = start + 1;
    while (index < end && this.lines[index]!.text !== fence) {
      content.push(this.lines[index]!.text);
      index++;
    }
    if (index === end) {
      this.addError(
        "NMD_CODE_FENCE_UNCLOSED",
        "The fenced code block is not closed.",
        opening
      );
      return { next: end };
    }
    const node: BlockNode = { type: "codeBlock", text: content.join("\n") };
    if (language) node.language = language;
    if (language) {
      const inspection = inspectStaticNotationFence(language, node.text);
      for (const issue of inspection?.issues ?? []) {
        this.addWarning(issue.code, issue.message, opening);
      }
    }
    return { node, next: index + 1 };
  }

  private list(
    start: number,
    end: number,
    ordered: boolean
  ): { node: BlockNode; next: number } {
    const items: ListItemNode[] = [];
    let index = start;
    let startValue = 1;

    while (index < end) {
      const line = this.lines[index]!;
      const match = /^(-|\d+\.) +(.*)$/.exec(line.text);
      if (!match || (match[1] !== "-") !== ordered) break;

      const position = items.length;
      if (ordered) {
        const marker = Number.parseInt(match[1]!.slice(0, -1), 10);
        if (position === 0) startValue = marker;
        else if (marker !== 1) {
          this.addError(
            "NMD_LIST_MARKER_NONCANONICAL",
            "Ordered list markers after the first must be 1.",
            line,
            1,
            match[1]!.length,
            "Replace the marker with 1."
          );
        }
      }

      let text = match[2]!;
      let checked: boolean | undefined;
      const task = /^\[([ xX])\] +(.*)$/.exec(text);
      if (task) {
        checked = task[1]!.toLowerCase() === "x";
        text = task[2]!;
      }

      const children: BlockNode[] = text
        ? [{ type: "paragraph", children: this.inline(text, line) }]
        : [];
      index++;

      const nested: Line[] = [];
      while (index < end) {
        const candidate = this.lines[index]!;
        if (candidate.text.trim() === "") {
          nested.push({ ...candidate, text: "" });
          index++;
        } else if (candidate.text.startsWith("  ")) {
          nested.push({ ...candidate, text: candidate.text.slice(2) });
          index++;
        } else {
          break;
        }
      }
      if (nested.some((item) => item.text.trim() !== "")) {
        children.push(
          ...this.withLines(nested, () => this.parseBlocks(0, nested.length))
        );
      }

      const item: ListItemNode = { type: "listItem", children };
      if (checked !== undefined) item.checked = checked;
      items.push(item);
    }

    const node: BlockNode = { type: "list", ordered, children: items };
    if (ordered && startValue !== 1) node.start = startValue;
    return { node, next: index };
  }

  private directive(
    index: number
  ): { node?: BlockNode; next: number } | undefined {
    const line = this.lines[index]!;
    if (line.text.startsWith("!toc")) {
      const toc = /^!toc(?:\{depth=([1-6])\})?$/.exec(line.text);
      if (!toc) {
        this.addError(
          "NMD_TOC_SYNTAX",
          "Use !toc or !toc{depth=1..6}.",
          line
        );
        return { next: index + 1 };
      }
      return {
        node: {
          type: "tableOfContents",
          ...(toc[1] ? { maxDepth: Number(toc[1]) } : {})
        },
        next: index + 1
      };
    }
    const callout = /^!(note|tip|warning|danger)\[([^\]]*)\]$/.exec(line.text);
    if (callout) {
      return {
        node: {
          type: "callout",
          kind: callout[1] as "note" | "tip" | "warning" | "danger",
          children: [
            { type: "paragraph", children: this.inline(callout[2]!, line) }
          ]
        },
        next: index + 1
      };
    }

    const media = /^!(audio|video)?\[([^\]]*)\]\(([^)]+)\)(.*)$/.exec(
      line.text
    );
    if (media) {
      const kind = media[1] ?? "image";
      const target = this.target(media[3]!, line);
      if (!target) return { next: index + 1 };
      const suffix = media[4]!.trim();
      let raw: Record<string, unknown> = {};
      let next = index + 1;
      if (suffix === "{") {
        const mapped = this.parseMap(index, "!" + kind, true);
        raw = mapped.values;
        next = mapped.next;
      } else if (suffix) {
        const compact = /^\{(.*)\}$/.exec(suffix);
        if (!compact) {
          this.addError(
            "NMD_DIRECTIVE_TRAILING",
            "Unexpected content after media directive.",
            line
          );
        } else {
          raw = this.compactAttributes(compact[1]!, line);
        }
      }

      const label = unescapeLabel(media[2]!);
      if (kind === "image") {
        const node: FigureNode = {
          type: "figure",
          resource: target,
          alt: label,
          children: []
        };
        const attributes = this.layoutAttributes(raw, line);
        if (attributes) node.attributes = attributes;
        if (label === "" && raw.decorative === true) node.decorative = true;
        else if (label === "") {
          this.addError(
            "NMD_IMAGE_ALT_REQUIRED",
            "An empty image description requires decorative=true.",
            line
          );
        }
        return { node, next };
      }

      const attributes = this.mediaAttributes(raw, line);
      if (kind === "audio") {
        const node: Extract<BlockNode, { type: "audio" }> = {
          type: "audio",
          resource: target,
          label: this.inline(label, line),
          children: []
        };
        if (attributes) node.attributes = attributes;
        return { node, next };
      }
      const node: Extract<BlockNode, { type: "video" }> = {
        type: "video",
        resource: target,
        label: this.inline(label, line),
        children: []
      };
      if (attributes) node.attributes = attributes;
      return { node, next };
    }

    const structured =
      /^!(diagram|chart|math|attachment)\[([^\]]*)\](?:\(([^)]+)\))? *\{$/.exec(
        line.text
      );
    if (structured) {
      return this.structuredDirective(structured, index, line);
    }

    const name = /^!([a-z][a-z0-9.-]*)/.exec(line.text)?.[1];
    if (name) {
      this.addError(
        NS.test(name) ? "NMD_EXTENSION_UNSUPPORTED" : "NMD_DIRECTIVE_UNKNOWN",
        NS.test(name)
          ? "Extension nodes are reserved but not implemented by this parser."
          : "Unknown core directive " + name + ".",
        line
      );
      return { next: index + 1 };
    }
    return undefined;
  }

  private structuredDirective(
    match: RegExpExecArray,
    index: number,
    line: Line
  ): { node?: BlockNode; next: number } {
    const kind = match[1]!;
    const label = match[2]!;
    const explicitTarget = match[3];
    const mapped = this.parseMap(index, "!" + kind, true);

    if (kind === "diagram") {
      const diagramType = mapped.values.type;
      const sourceText = mapped.values.source;
      if (
        diagramType !== "flow" &&
        diagramType !== "sequence" &&
        diagramType !== "architecture"
      ) {
        this.addError(
          "NMD_DIAGRAM_TYPE_INVALID",
          "Diagram type must be flow, sequence, or architecture.",
          line
        );
        return { next: mapped.next };
      }
      if (typeof sourceText !== "string") {
        this.addError(
          "NMD_DIAGRAM_SOURCE_REQUIRED",
          "A diagram requires a source reference.",
          line
        );
        return { next: mapped.next };
      }
      const source = this.target(sourceText, line);
      return source
        ? {
            node: {
              type: "diagram",
              diagramType,
              source,
              children: label
                ? [{ type: "paragraph", children: this.inline(label, line) }]
                : []
            },
            next: mapped.next
          }
        : { next: mapped.next };
    }

    if (kind === "chart") {
      const chartType = mapped.values.type;
      const dataText = mapped.values.data;
      if (
        chartType !== "bar" &&
        chartType !== "line" &&
        chartType !== "area" &&
        chartType !== "scatter" &&
        chartType !== "pie"
      ) {
        this.addError(
          "NMD_CHART_TYPE_INVALID",
          "Chart type must be bar, line, area, scatter, or pie.",
          line
        );
        return { next: mapped.next };
      }
      if (typeof dataText !== "string") {
        this.addError(
          "NMD_CHART_DATA_REQUIRED",
          "A chart requires a data reference.",
          line
        );
        return { next: mapped.next };
      }
      const data = this.target(dataText, line);
      return data
        ? {
            node: {
              type: "chart",
              chartType,
              data,
              children: label
                ? [{ type: "paragraph", children: this.inline(label, line) }]
                : []
            },
            next: mapped.next
          }
        : { next: mapped.next };
    }

    if (kind === "math") {
      const source = mapped.values.source;
      const notation = mapped.values.notation ?? "tex";
      if (typeof source !== "string") {
        this.addError(
          "NMD_MATH_SOURCE_REQUIRED",
          "A math block requires source text.",
          line
        );
        return { next: mapped.next };
      }
      if (notation !== "tex" && notation !== "asciimath") {
        this.addError(
          "NMD_MATH_NOTATION_INVALID",
          "Math notation must be tex or asciimath.",
          line
        );
        return { next: mapped.next };
      }
      return {
        node: { type: "mathBlock", source, notation },
        next: mapped.next
      };
    }

    if (!explicitTarget) {
      this.addError(
        "NMD_ATTACHMENT_TARGET_REQUIRED",
        "An attachment requires a target.",
        line
      );
      return { next: mapped.next };
    }
    const resource = this.target(explicitTarget, line);
    return resource
      ? {
          node: {
            type: "attachment",
            resource,
            label: this.inline(label, line),
            children: []
          },
          next: mapped.next
        }
      : { next: mapped.next };
  }

  private inline(source: string, line: Line): InlineNode[] {
    const nodes: InlineNode[] = [];
    let index = 0;
    const text = (value: string): void => {
      if (!value) return;
      const previous = nodes.at(-1);
      if (previous?.type === "text") previous.text += value;
      else nodes.push({ type: "text", text: value });
    };

    while (index < source.length) {
      const tail = source.slice(index);
      const run = /^[*_]{3,}/.exec(tail);
      if (run) {
        this.addError(
          "NMD_INLINE_DELIMITER_AMBIGUOUS",
          "Runs of three or more emphasis delimiters are forbidden in 0.1.",
          line,
          index + 1,
          run[0].length,
          "Use different delimiters for nested emphasis."
        );
        text(run[0]);
        index += run[0].length;
        continue;
      }
      if (tail.startsWith("\\\n")) {
        nodes.push({ type: "hardBreak" });
        index += 2;
        continue;
      }
      if (tail[0] === "\n") {
        text(" ");
        index++;
        continue;
      }
      if (tail[0] === GRAVE) {
        const close = source.indexOf(GRAVE, index + 1);
        const newline = source.indexOf("\n", index + 1);
        if (close >= 0 && (newline < 0 || close < newline)) {
          nodes.push({ type: "code", text: source.slice(index + 1, close) });
          index = close + 1;
          continue;
        }
        this.addError(
          "NMD_CODE_SPAN_UNCLOSED",
          "The inline code span is not closed.",
          line,
          index + 1
        );
      }

      const image = /^!\[([^\]]*)\]\(([^)]+)\)(?:\{([^}]*)\})?/.exec(tail);
      if (image) {
        const resource = this.target(image[2]!, line);
        if (resource) {
          const alt = unescapeLabel(image[1]!);
          const raw = image[3]
            ? this.compactAttributes(image[3], line)
            : {};
          const node: InlineNode = { type: "image", resource, alt };
          const attributes = this.layoutAttributes(raw, line);
          if (attributes) node.attributes = attributes;
          if (alt === "" && raw.decorative === true) node.decorative = true;
          else if (alt === "") {
            this.addError(
              "NMD_IMAGE_ALT_REQUIRED",
              "An empty image description requires decorative=true.",
              line
            );
          }
          nodes.push(node);
        }
        index += image[0].length;
        continue;
      }

      const footnote = /^\[\^([A-Za-z][A-Za-z0-9._-]*)\]/.exec(tail);
      if (footnote) {
        const id = footnote[1]!;
        nodes.push({ type: "footnoteReference", target: id });
        this.footnoteRefs.push({ id, line });
        index += footnote[0].length;
        continue;
      }

      const cross = /^\[([^\]]+)\]\(#([A-Za-z][A-Za-z0-9._-]*)\)/.exec(tail);
      if (cross) {
        const id = cross[2]!;
        nodes.push({
          type: "crossReference",
          target: { kind: "internal", id },
          children: this.inline(cross[1]!, line)
        });
        this.internalRefs.push({ id, line });
        index += cross[0].length;
        continue;
      }

      const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(tail);
      if (link) {
        const target = this.target(link[2]!, line);
        if (target) {
          nodes.push({
            type: "link",
            target,
            children: this.inline(link[1]!, line)
          });
        }
        index += link[0].length;
        continue;
      }

      const strong =
        tail.startsWith("**") ? "**" : tail.startsWith("__") ? "__" : "";
      if (strong) {
        const close = closing(source, strong, index + 2);
        if (close >= 0) {
          nodes.push({
            type: "strong",
            children: this.inline(source.slice(index + 2, close), line)
          });
          index = close + 2;
          continue;
        }
      }

      const emphasis = tail[0] === "*" || tail[0] === "_" ? tail[0] : "";
      if (emphasis && source[index + 1] && !/\s/.test(source[index + 1]!)) {
        const close = closing(source, emphasis, index + 1);
        if (
          close >= 0 &&
          !(
            emphasis === "_" &&
            word(source[index - 1]) &&
            word(source[close + 1])
          )
        ) {
          nodes.push({
            type: "emphasis",
            children: this.inline(source.slice(index + 1, close), line)
          });
          index = close + 1;
          continue;
        }
      }

      if (tail[0] === "$") {
        const close = closing(source, "$", index + 1);
        if (close >= 0) {
          nodes.push({
            type: "mathInline",
            source: source.slice(index + 1, close),
            notation: "tex"
          });
          index = close + 1;
          continue;
        }
      }

      if (tail[0] === "\\") {
        const escaped = tail[1];
        const allowed = "\\*_" + GRAVE + "[]()#!{}$>-.";
        if (escaped && allowed.includes(escaped)) {
          text(escaped);
          index += 2;
          continue;
        }
        this.addError(
          "NMD_ESCAPE_INVALID",
          "This character cannot be escaped.",
          line,
          index + 1,
          2
        );
      }

      text(source[index]!);
      index++;
    }
    return nodes;
  }

  private parseMap(
    opening: number,
    owner: string,
    onOwnerLine = false
  ): MapResult {
    const values: Record<string, unknown> = {};
    let index = opening + 1;
    let closed = false;
    while (index < this.lines.length) {
      const line = this.lines[index]!;
      if (line.text === "}") {
        closed = true;
        index++;
        break;
      }
      const entry =
        /^  ([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*): +(.*)$/.exec(line.text);
      if (!entry) {
        this.addError(
          "NMD_MAP_ENTRY_INVALID",
          "Map entries require exactly two spaces, a key, colon, and value.",
          line
        );
        index++;
        continue;
      }
      const key = entry[1]!;
      if (Object.hasOwn(values, key)) {
        this.addError(
          "NMD_ATTRIBUTE_DUPLICATE",
          "Attribute " + key + " occurs more than once.",
          line
        );
      } else {
        values[key] = this.scalar(entry[2]!, line);
      }
      index++;
    }
    if (!closed) {
      this.addError(
        "NMD_MAP_UNCLOSED",
        "The map for " + owner + " is not closed.",
        this.lines[opening]!
      );
    }
    if (!onOwnerLine && this.lines[opening]?.text !== owner + " {") {
      this.addError(
        "NMD_MAP_OPEN_INVALID",
        "Invalid map opening.",
        this.lines[opening]!
      );
    }
    return { values, next: index };
  }

  private compactAttributes(
    source: string,
    line: Line
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const pattern =
      /([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)=("(?:[^"\\]|\\.)*"|[^\s]+)/gy;
    let offset = 0;
    while (offset < source.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(source);
      if (!match) {
        this.addError(
          "NMD_ATTRIBUTE_INVALID",
          "Invalid compact attribute syntax.",
          line
        );
        break;
      }
      const key = match[1]!;
      if (Object.hasOwn(result, key)) {
        this.addError(
          "NMD_ATTRIBUTE_DUPLICATE",
          "Attribute " + key + " occurs more than once.",
          line
        );
      } else result[key] = this.scalar(match[2]!, line);
      offset = pattern.lastIndex;
      while (source[offset] === " ") offset++;
    }
    return result;
  }

  private scalar(source: string, line: Line): unknown {
    if (source === "true") return true;
    if (source === "false") return false;
    if (/^-?\d+$/.test(source)) return Number.parseInt(source, 10);
    if (source.startsWith('"')) {
      try {
        return JSON.parse(source) as unknown;
      } catch {
        this.addError("NMD_STRING_INVALID", "Invalid quoted string.", line);
        return "";
      }
    }
    if (!/^[A-Za-z0-9_./:+-]+$/.test(source)) {
      this.addError("NMD_VALUE_INVALID", "Invalid bare value.", line);
    }
    return source;
  }

  private metadataFrom(
    values: Record<string, unknown>,
    line: Line
  ): DocumentMetadata {
    const result: DocumentMetadata = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === "title" && typeof value === "string") result.title = value;
      else if (key === "language" && typeof value === "string" && LANG.test(value)) {
        result.language = value;
      } else if (
        key === "theme" &&
        (value === "standard" || value === "paper" || value === "technical")
      ) result.theme = value;
      else if (
        key === "accent" &&
        (value === "blue" ||
          value === "green" ||
          value === "orange" ||
          value === "violet" ||
          value === "neutral")
      ) result.accent = value;
      else if (
        key === "density" &&
        (value === "compact" || value === "comfortable")
      ) result.density = value;
      else if (NS.test(key)) result[key] = value;
      else {
        this.addError(
          "NMD_METADATA_INVALID",
          "Unknown or invalid metadata field " + key + ".",
          line
        );
      }
    }
    return result;
  }

  private layoutAttributes(
    raw: Record<string, unknown>,
    line: Line
  ): FigureNode["attributes"] | undefined {
    const result: NonNullable<FigureNode["attributes"]> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "layout") {
        if (
          value === "inline" ||
          value === "normal" ||
          value === "wide" ||
          value === "full" ||
          value === "gallery"
        ) result.layout = value;
        else this.badAttribute(key, line);
      } else if (key !== "decorative") {
        this.unknownAttribute(key, line);
      }
    }
    return Object.keys(result).length ? result : undefined;
  }

  private mediaAttributes(
    raw: Record<string, unknown>,
    line: Line
  ): MediaAttributes | undefined {
    const result: MediaAttributes = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "layout") {
        if (value === "normal" || value === "wide" || value === "full") {
          result.layout = value;
        } else this.badAttribute(key, line);
      } else if (key === "start") {
        if (
          typeof value === "string" &&
          /^(?:\d+:)?[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(value)
        ) result.start = value;
        else this.badAttribute(key, line);
      } else if (
        key === "poster" ||
        key === "transcript" ||
        key === "chapters"
      ) {
        const asset = this.assetAttribute(value, key, line);
        if (asset) result[key] = asset;
      } else if (key.startsWith("captions.")) {
        const language = key.slice(9);
        const asset = this.assetAttribute(value, key, line);
        if (!LANG.test(language)) {
          this.addError(
            "NMD_CAPTION_LANGUAGE_INVALID",
            "Invalid caption language " + language + ".",
            line
          );
        } else if (asset) {
          result.captions ??= {};
          result.captions[language] = asset;
        }
      } else this.unknownAttribute(key, line);
    }
    return Object.keys(result).length ? result : undefined;
  }

  private assetAttribute(
    value: unknown,
    key: string,
    line: Line
  ): { kind: "asset"; id: string } | undefined {
    if (typeof value !== "string" || !value.startsWith("asset:")) {
      this.addError(
        "NMD_ATTRIBUTE_ASSET_REQUIRED",
        "Attribute " + key + " requires an asset reference.",
        line
      );
      return undefined;
    }
    const id = value.slice(6);
    if (!ID.test(id)) {
      this.addError(
        "NMD_ASSET_ID_INVALID",
        "Invalid asset identifier " + id + ".",
        line
      );
      return undefined;
    }
    return { kind: "asset", id };
  }

  private target(source: string, line: Line): Reference | undefined {
    if (source.startsWith("asset:")) {
      const id = source.slice(6);
      if (ID.test(id)) return { kind: "asset", id };
      this.addError(
        "NMD_ASSET_ID_INVALID",
        "Invalid asset identifier " + id + ".",
        line
      );
      return undefined;
    }
    if (source.startsWith("https://")) {
      try {
        const url = new URL(source);
        return { kind: "external", uri: url.toString() };
      } catch {
        this.addError("NMD_URI_INVALID", "Invalid HTTPS URI.", line);
        return undefined;
      }
    }
    if (source.startsWith("#")) {
      const id = source.slice(1);
      if (!ID.test(id)) {
        this.addError(
          "NMD_REFERENCE_ID_INVALID",
          "Invalid internal reference identifier.",
          line
        );
        return undefined;
      }
      this.internalRefs.push({ id, line });
      return { kind: "internal", id };
    }
    this.addError(
      "NMD_REFERENCE_UNRESOLVED_LOCAL",
      "Local references must be converted to asset IDs before canonical parsing.",
      line,
      1,
      Math.max(1, source.length),
      "Import the file and use asset:identifier."
    );
    return undefined;
  }

  private registerId(id: string, line: Line): string | undefined {
    if (!ID.test(id)) {
      this.addError("NMD_ID_INVALID", "Invalid identifier " + id + ".", line);
      return undefined;
    }
    if (this.ids.has(id)) {
      this.addError(
        "NMD_ID_DUPLICATE",
        "Identifier " + id + " occurs more than once.",
        line
      );
      return undefined;
    }
    this.ids.add(id);
    return id;
  }

  private resolveReferences(): void {
    for (const reference of this.internalRefs) {
      if (!this.ids.has(reference.id)) {
        this.addError(
          "NMD_REFERENCE_UNRESOLVED",
          "Internal reference " + reference.id + " has no target.",
          reference.line
        );
      }
    }
    for (const reference of this.footnoteRefs) {
      if (!Object.hasOwn(this.footnotes, reference.id)) {
        this.addError(
          "NMD_FOOTNOTE_UNRESOLVED",
          "Footnote " + reference.id + " has no definition.",
          reference.line
        );
      }
    }
  }

  private blockStart(text: string): boolean {
    return (
      text.startsWith(GRAVE.repeat(3)) ||
      /^(#{1,6}) +/.test(text) ||
      text === "---" ||
      /^>($| )/.test(text) ||
      /^(-|\d+\.) +/.test(text) ||
      /^\[\^[A-Za-z][A-Za-z0-9._-]*\]: +/.test(text) ||
      /^!(?:\[|[a-z])/.test(text)
    );
  }

  private blank(index: number): boolean {
    return this.lines[index]?.text.trim() === "";
  }

  private withLines<T>(lines: Line[], operation: () => T): T {
    const original = this.lines;
    this.lines = lines;
    try {
      return operation();
    } finally {
      this.lines = original;
    }
  }

  private badAttribute(key: string, line: Line): void {
    this.addError(
      "NMD_ATTRIBUTE_VALUE",
      "Attribute " + key + " has an unsupported value.",
      line
    );
  }

  private unknownAttribute(key: string, line: Line): void {
    this.addError(
      "NMD_ATTRIBUTE_UNKNOWN",
      "Unknown attribute " + key + ".",
      line
    );
  }

  private addError(
    code: string,
    message: string,
    line: Line,
    column = 1,
    length = Math.max(1, line.text.length),
    suggestion?: string
  ): void {
    const diagnostic: Diagnostic = {
      code,
      severity: "error",
      message,
      range: range(line, column, length)
    };
    if (suggestion) diagnostic.suggestion = suggestion;
    this.diagnostics.push(diagnostic);
  }

  private addWarning(code: string, message: string, line: Line): void {
    this.diagnostics.push({
      code,
      severity: "warning",
      message,
      range: range(line, 1, Math.max(1, line.text.length))
    });
  }
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (normalized.includes("\0")) {
    return {
      diagnostics: [
        {
          code: "NMD_TEXT_NUL",
          severity: "error",
          message: "NUL is forbidden in NotMarkdown source.",
          range: range({ text: "", number: 1, offset: 0 }, 1, 1)
        }
      ]
    };
  }
  return new Parser(normalized, options).run();
}

function makeLines(source: string): Line[] {
  if (!source) return [];
  const raw = source.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const result: Line[] = [];
  let offset = 0;
  raw.forEach((text, index) => {
    result.push({ text, number: index + 1, offset });
    offset += text.length + 1;
  });
  return result;
}

function range(line: Line, column: number, length: number): SourceRange {
  return {
    start: {
      offset: line.offset + column - 1,
      line: line.number,
      column
    },
    end: {
      offset: line.offset + column - 1 + Math.max(1, length),
      line: line.number,
      column: column + Math.max(1, length)
    }
  };
}

function closing(source: string, marker: string, from: number): number {
  let cursor = from;
  while (cursor < source.length) {
    const found = source.indexOf(marker, cursor);
    if (found < 0) return -1;
    const newline = source.indexOf("\n", cursor);
    if (newline >= 0 && newline < found) return -1;
    if (source[found - 1] !== "\\" && !/\s/.test(source[found - 1] ?? "")) {
      return found;
    }
    cursor = found + marker.length;
  }
  return -1;
}

function word(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function unescapeLabel(source: string): string {
  return source.replace(/\\([\\*_[\]()#!{}$>.-])/g, "$1");
}
