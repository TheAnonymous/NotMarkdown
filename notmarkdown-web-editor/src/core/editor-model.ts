import {
  Schema,
  type Mark,
  type MarkSpec,
  type NodeSpec,
  type Node as ProseMirrorNode
} from "prosemirror-model";
import type { DOMOutputSpec } from "prosemirror-model";
import { addListNodes } from "prosemirror-schema-list";
import type {
  BlockNode,
  DocumentNode,
  InlineNode,
  Reference
} from "@notmarkdown/reference-toolchain";

const GRAVE = String.fromCharCode(96);

const baseNodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0] as const
  },
  heading: {
    attrs: { level: { default: 1 }, id: { default: null } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: "h" + level,
      attrs: { level }
    })),
    toDOM: (node: ProseMirrorNode) =>
      [
        "h" + String(node.attrs.level),
        node.attrs.id ? { id: node.attrs.id } : {},
        0
      ] as const
  },
  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0] as const
  },
  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"] as const
  },
  code_block: {
    attrs: { language: { default: "" } },
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" as const }],
    toDOM: () => ["pre", ["code", 0]] as const
  },
  static_visual: {
    attrs: { language: {}, source: {} },
    group: "block",
    atom: true,
    selectable: true,
    toDOM: (node: ProseMirrorNode) => [
      "figure",
      { class: "nmd-static-visual", "data-language": node.attrs.language },
      ["figcaption", node.attrs.language],
      ["pre", ["code", node.attrs.source]]
    ] as DOMOutputSpec
  },
  callout: {
    attrs: { kind: { default: "note" } },
    content: "block+",
    group: "block",
    defining: true,
    toDOM: (node: ProseMirrorNode) =>
      ["aside", { class: "nmd-callout " + node.attrs.kind }, 0] as const
  },
  table_of_contents: {
    attrs: { maxDepth: { default: null } },
    group: "block",
    atom: true,
    selectable: true,
    toDOM: () => ["nav", { class: "nmd-toc" }, "Automatic contents"] as const
  },
  figure: {
    attrs: {
      assetId: {},
      alt: { default: "" },
      layout: { default: "normal" },
      decorative: { default: false }
    },
    group: "block",
    atom: true,
    selectable: true,
    toDOM: (node: ProseMirrorNode) =>
      [
        "figure",
        {
          class: "nmd-media-node",
          "data-asset": node.attrs.assetId,
          "data-kind": "image"
        },
        ["span", { class: "media-symbol" }, "▧"],
        ["figcaption", node.attrs.alt || "Decorative image"]
      ] as const
  },
  audio: mediaNodeSpec("audio"),
  video: mediaNodeSpec("video"),
  inline_image: {
    attrs: {
      assetId: {},
      alt: { default: "" },
      layout: { default: "inline" },
      decorative: { default: false }
    },
    inline: true,
    group: "inline",
    atom: true,
    toDOM: (node: ProseMirrorNode) =>
      [
        "span",
        {
          class: "nmd-inline-media",
          "data-asset": node.attrs.assetId
        },
        node.attrs.alt || "▧"
      ] as const
  },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"] as const
  },
  footnote_ref: {
    attrs: { target: {} },
    inline: true,
    group: "inline",
    atom: true,
    toDOM: (node: ProseMirrorNode) =>
      ["sup", { class: "nmd-footnote" }, "[" + node.attrs.target + "]"] as const
  },
  math_inline: {
    attrs: { source: {} },
    inline: true,
    group: "inline",
    atom: true,
    toDOM: (node: ProseMirrorNode) =>
      ["span", { class: "nmd-math" }, "$" + node.attrs.source + "$"] as const
  },
  raw_block: {
    attrs: { source: {}, label: { default: "Unsupported block" } },
    group: "block",
    atom: true,
    toDOM: (node: ProseMirrorNode) =>
      [
        "div",
        { class: "nmd-raw-block" },
        ["strong", node.attrs.label],
        ["code", node.attrs.source]
      ] as const
  },
  text: { group: "inline" }
};

const marks: Record<string, MarkSpec> = {
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: () => ["strong", 0] as DOMOutputSpec
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: () => ["em", 0] as DOMOutputSpec
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0] as DOMOutputSpec
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (element: HTMLElement | string) =>
            typeof element === "string"
              ? false
              : { href: element.getAttribute("href") }
        }
      ],
      toDOM: (mark: Mark) =>
        ["a", { href: mark.attrs.href, rel: "noreferrer" }, 0] as DOMOutputSpec
    }
};

const primitiveSchema = new Schema({
  nodes: baseNodes,
  marks
});

export const editorSchema = new Schema({
  nodes: addListNodes(primitiveSchema.spec.nodes, "paragraph block*", "block"),
  marks: primitiveSchema.spec.marks
});

export function documentToEditorNode(document: DocumentNode): ProseMirrorNode {
  const content = document.children
    .map(blockToEditorNode)
    .filter((node): node is ProseMirrorNode => Boolean(node));
  return editorSchema.node(
    "doc",
    undefined,
    content.length ? content : [editorSchema.node("paragraph")]
  );
}

export function editorNodeToSource(
  node: ProseMirrorNode,
  previous: DocumentNode
): string {
  const lines: string[] = ["@notmarkdown 0.1", ""];
  const metadata = previous.metadata;
  const metadataEntries = Object.entries(metadata).filter(
    ([, value]) => value !== undefined
  );
  if (metadataEntries.length) {
    lines.push("@document {");
    for (const [key, value] of metadataEntries) {
      lines.push("  " + key + ": " + scalar(value));
    }
    lines.push("}", "");
  }

  node.forEach((child) => {
    lines.push(...serializeBlock(child), "");
  });

  for (const [id, blocks] of Object.entries(previous.definitions.footnotes)) {
    const rendered = blocks
      .map((block) => {
        const pm = blockToEditorNode(block);
        return pm ? serializeBlock(pm).join("\n") : "";
      })
      .join("\n");
    lines.push("[^" + id + "]: " + rendered.replace(/\n/g, "\n  "), "");
  }

  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n") + "\n";
}

function blockToEditorNode(block: BlockNode): ProseMirrorNode | undefined {
  if (block.type === "paragraph") {
    return editorSchema.node("paragraph", undefined, inlineToEditor(block.children));
  }
  if (block.type === "heading") {
    return editorSchema.node(
      "heading",
      { level: block.level, id: block.id ?? null },
      inlineToEditor(block.children)
    );
  }
  if (block.type === "thematicBreak") return editorSchema.node("horizontal_rule");
  if (block.type === "blockQuote") {
    return editorSchema.node(
      "blockquote",
      undefined,
      block.children
        .map(blockToEditorNode)
        .filter((value): value is ProseMirrorNode => Boolean(value))
    );
  }
  if (block.type === "list") {
    const name = block.ordered ? "ordered_list" : "bullet_list";
    return editorSchema.node(
      name,
      block.ordered ? { order: block.start ?? 1 } : undefined,
      block.children.map((item) =>
        editorSchema.node(
          "list_item",
          undefined,
          item.children
            .map(blockToEditorNode)
            .filter((value): value is ProseMirrorNode => Boolean(value))
        )
      )
    );
  }
  if (block.type === "codeBlock") {
    if (block.language === "mermaid" || block.language === "vega-lite" || block.language === "vegalite") {
      return editorSchema.node("static_visual", {
        language: block.language,
        source: block.text
      });
    }
    return editorSchema.node(
      "code_block",
      { language: block.language ?? "" },
      block.text ? editorSchema.text(block.text) : undefined
    );
  }
  if (block.type === "callout") {
    return editorSchema.node(
      "callout",
      { kind: block.kind },
      block.children
        .map(blockToEditorNode)
        .filter((value): value is ProseMirrorNode => Boolean(value))
    );
  }
  if (block.type === "tableOfContents") {
    return editorSchema.node("table_of_contents", {
      maxDepth: block.maxDepth ?? null
    });
  }
  if (block.type === "figure") {
    return editorSchema.node("figure", {
      assetId: referenceId(block.resource),
      alt: block.alt,
      layout: block.attributes?.layout ?? "normal",
      decorative: block.decorative ?? false
    });
  }
  if (block.type === "audio" || block.type === "video") {
    return editorSchema.node(block.type, {
      assetId: referenceId(block.resource),
      label: plainText(block.label),
      attributes: JSON.stringify(block.attributes ?? {})
    });
  }
  return editorSchema.node("raw_block", {
    source: serializeSpecialBlock(block),
    label: block.type
  });
}

function inlineToEditor(
  nodes: InlineNode[],
  marks: readonly Mark[] = []
): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.text) result.push(editorSchema.text(node.text, marks));
    } else if (node.type === "strong") {
      result.push(
        ...inlineToEditor(node.children, [
          ...marks,
          editorSchema.marks.strong.create()
        ])
      );
    } else if (node.type === "emphasis") {
      result.push(
        ...inlineToEditor(node.children, [...marks, editorSchema.marks.em.create()])
      );
    } else if (node.type === "code") {
      result.push(
        editorSchema.text(node.text, [...marks, editorSchema.marks.code.create()])
      );
    } else if (node.type === "link") {
      result.push(
        ...inlineToEditor(node.children, [
          ...marks,
          editorSchema.marks.link.create({ href: referenceTarget(node.target) })
        ])
      );
    } else if (node.type === "crossReference") {
      result.push(
        ...inlineToEditor(node.children, [
          ...marks,
          editorSchema.marks.link.create({ href: "#" + node.target.id })
        ])
      );
    } else if (node.type === "image") {
      result.push(
        editorSchema.node("inline_image", {
          assetId: referenceId(node.resource),
          alt: node.alt,
          layout: node.attributes?.layout ?? "inline",
          decorative: node.decorative ?? false
        })
      );
    } else if (node.type === "hardBreak") {
      result.push(editorSchema.node("hard_break"));
    } else if (node.type === "footnoteReference") {
      result.push(editorSchema.node("footnote_ref", { target: node.target }));
    } else if (node.type === "mathInline") {
      result.push(editorSchema.node("math_inline", { source: node.source }));
    }
  }
  return result;
}

function serializeBlock(node: ProseMirrorNode, indent = ""): string[] {
  if (node.type.name === "paragraph") {
    return [indent + serializeInline(node)];
  }
  if (node.type.name === "heading") {
    const anchor = node.attrs.id ? " {#" + node.attrs.id + "}" : "";
    return [
      indent +
        "#".repeat(node.attrs.level as number) +
        " " +
        serializeInline(node) +
        anchor
    ];
  }
  if (node.type.name === "horizontal_rule") return [indent + "---"];
  if (node.type.name === "blockquote") {
    const lines: string[] = [];
    node.forEach((child) => {
      lines.push(...serializeBlock(child).map((line) => indent + "> " + line));
    });
    return lines;
  }
  if (node.type.name === "ordered_list" || node.type.name === "bullet_list") {
    const ordered = node.type.name === "ordered_list";
    const lines: string[] = [];
    node.forEach((item, offset) => {
      const marker = ordered
        ? offset === 0 && node.attrs.order !== 1
          ? String(node.attrs.order) + ". "
          : "1. "
        : "- ";
      const children: string[] = [];
      item.forEach((child) => children.push(...serializeBlock(child)));
      if (children.length) {
        lines.push(indent + marker + children[0]);
        lines.push(...children.slice(1).map((line) => indent + "  " + line));
      }
    });
    return lines;
  }
  if (node.type.name === "code_block") {
    return [
      indent + GRAVE.repeat(3) + (node.attrs.language || ""),
      ...node.textContent.split("\n").map((line) => indent + line),
      indent + GRAVE.repeat(3)
    ];
  }
  if (node.type.name === "static_visual") {
    return [
      indent + GRAVE.repeat(3) + node.attrs.language,
      ...String(node.attrs.source).split("\n").map((line) => indent + line),
      indent + GRAVE.repeat(3)
    ];
  }
  if (node.type.name === "callout") {
    return [
      indent +
        "!" +
        node.attrs.kind +
        "[" +
        escapeLabel(node.textContent) +
        "]"
    ];
  }
  if (node.type.name === "table_of_contents") {
    return [
      indent +
        "!toc" +
        (node.attrs.maxDepth ? "{depth=" + node.attrs.maxDepth + "}" : "")
    ];
  }
  if (node.type.name === "figure") {
    const extra =
      node.attrs.layout && node.attrs.layout !== "normal"
        ? "{layout=" + node.attrs.layout + "}"
        : node.attrs.decorative
          ? "{decorative=true}"
          : "";
    return [
      indent +
        "![" +
        escapeLabel(node.attrs.alt) +
        "](asset:" +
        node.attrs.assetId +
        ")" +
        extra
    ];
  }
  if (node.type.name === "audio" || node.type.name === "video") {
    const attributes = JSON.parse(node.attrs.attributes || "{}") as Record<
      string,
      unknown
    >;
    const first =
      indent +
      "!" +
      node.type.name +
      "[" +
      escapeLabel(node.attrs.label) +
      "](asset:" +
      node.attrs.assetId +
      ")";
    const entries = flattenAttributes(attributes);
    if (!entries.length) return [first];
    return [
      first + " {",
      ...entries.map(([key, value]) => "  " + key + ": " + scalar(value)),
      "}"
    ];
  }
  if (node.type.name === "raw_block") return [node.attrs.source];
  return [indent + node.textContent];
}

function serializeInline(node: ProseMirrorNode): string {
  let output = "";
  node.forEach((child) => {
    if (child.isText) {
      const code = child.marks.some((mark) => mark.type.name === "code");
      let text = code ? child.text ?? "" : escapeText(child.text ?? "");
      if (code) text = GRAVE + text + GRAVE;
      if (child.marks.some((mark) => mark.type.name === "em")) {
        text = "*" + text + "*";
      }
      if (child.marks.some((mark) => mark.type.name === "strong")) {
        text = "**" + text + "**";
      }
      const link = child.marks.find((mark) => mark.type.name === "link");
      if (link) text = "[" + text + "](" + link.attrs.href + ")";
      output += text;
    } else if (child.type.name === "hard_break") {
      output += "\\\n";
    } else if (child.type.name === "inline_image") {
      output +=
        "![" +
        escapeLabel(child.attrs.alt) +
        "](asset:" +
        child.attrs.assetId +
        ")";
    } else if (child.type.name === "footnote_ref") {
      output += "[^" + child.attrs.target + "]";
    } else if (child.type.name === "math_inline") {
      output += "$" + child.attrs.source + "$";
    }
  });
  return output;
}

function serializeSpecialBlock(block: BlockNode): string {
  if (block.type === "diagram") {
    return [
      "!diagram[Diagram] {",
      "  type: " + block.diagramType,
      "  source: " + referenceTarget(block.source),
      "}"
    ].join("\n");
  }
  if (block.type === "chart") {
    return [
      "!chart[Chart] {",
      "  type: " + block.chartType,
      "  data: " +
        (typeof block.data === "object" && "kind" in block.data
          ? referenceTarget(block.data)
          : "asset:chart-data"),
      "}"
    ].join("\n");
  }
  if (block.type === "mathBlock") {
    return [
      "!math[] {",
      "  notation: " + block.notation,
      "  source: " + JSON.stringify(block.source),
      "}"
    ].join("\n");
  }
  if (block.type === "attachment") {
    return (
      "!attachment[" +
      escapeLabel(plainText(block.label)) +
      "](" +
      referenceTarget(block.resource) +
      ") {\n}"
    );
  }
  return "";
}

function mediaNodeSpec(kind: "audio" | "video"): NodeSpec {
  return {
    attrs: {
      assetId: {},
      label: { default: "" },
      attributes: { default: "{}" }
    },
    group: "block",
    atom: true,
    selectable: true,
    toDOM: (node: ProseMirrorNode) =>
      [
        "figure",
        {
          class: "nmd-media-node",
          "data-asset": node.attrs.assetId,
          "data-kind": kind
        },
        ["span", { class: "media-symbol" }, kind === "audio" ? "◖" : "▷"],
        ["figcaption", node.attrs.label || kind]
      ] as const
  };
}

function referenceId(reference: Reference): string {
  return reference.kind === "asset"
    ? reference.id
    : reference.kind === "internal"
      ? reference.id
      : reference.uri;
}

function referenceTarget(reference: Reference): string {
  if (reference.kind === "asset") return "asset:" + reference.id;
  if (reference.kind === "internal") return "#" + reference.id;
  return reference.uri;
}

function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text"
        ? node.text
        : "children" in node
          ? plainText(node.children)
          : ""
    )
    .join("");
}

function escapeText(value: string): string {
  const special = new Set(["\\", "*", "_", GRAVE, "[", "]", "$"]);
  return [...value].map((char) => (special.has(char) ? "\\" + char : char)).join("");
}

function escapeLabel(value: string): string {
  return value.replace(/([\\\]])/g, "\\$1");
}

function scalar(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_./:+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function flattenAttributes(
  value: Record<string, unknown>,
  prefix = ""
): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      result.push(...flattenAttributes(child as Record<string, unknown>, path));
    } else result.push([path, child]);
  }
  return result;
}
