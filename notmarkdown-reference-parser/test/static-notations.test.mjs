import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchIndex,
  inspectStaticNotationFence,
  parse,
  staticNotationForLanguage
} from "../dist/index.js";

const fence = String.fromCharCode(96).repeat(3);
const document = (...lines) => ["@notmarkdown 0.1", "", ...lines].join("\n");

test("canonical static fences remain inert lossless code blocks and searchable", () => {
  const mermaid = "flowchart LR\n  Source --> Package";
  const vega = '{"data":{"values":[{"x":"A","y":2}]},"mark":"bar","encoding":{"x":{"field":"x"},"y":{"field":"y"}}}';
  const parsed = parse(
    document(
      fence + "mermaid",
      ...mermaid.split("\n"),
      fence,
      "",
      fence + "vegalite",
      vega,
      fence
    )
  );
  assert.ok(parsed.document);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.document.children[0], {
    type: "codeBlock",
    language: "mermaid",
    text: mermaid
  });
  assert.equal(parsed.document.children[1].language, "vegalite");
  assert.equal(parsed.document.children[1].text, vega);
  const index = buildSearchIndex(parsed.document);
  assert.equal(index.entries.some((entry) => entry.text.includes("Source --> Package")), true);
  assert.equal(index.entries.some((entry) => entry.text.includes('"mark":"bar"')), true);
});

test("static notation identifiers are exact lowercase tokens", () => {
  assert.equal(staticNotationForLanguage("mermaid"), "mermaid");
  assert.equal(staticNotationForLanguage("vega-lite"), "vega-lite");
  assert.equal(staticNotationForLanguage("vegalite"), "vega-lite");
  for (const language of ["Mermaid", "VEGA-LITE", "vl", "vega_lite"]) {
    assert.equal(staticNotationForLanguage(language), undefined);
    assert.equal(inspectStaticNotationFence(language, "anything"), undefined);
  }
  const parsed = parse(document(fence + "Mermaid", "click A href \"https://example.org\"", fence));
  assert.ok(parsed.document);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.document.children[0].language, "Mermaid");
});

test("Mermaid preflight permits static source", () => {
  const inspected = inspectStaticNotationFence(
    "mermaid",
    "sequenceDiagram\n  Alice->>Bob: Package document"
  );
  assert.ok(inspected);
  assert.equal(inspected.renderable, true);
  assert.deepEqual(inspected.issues, []);
});

test("static preflight remains browser-compatible without global Buffer", () => {
  const buffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const inspected = inspectStaticNotationFence("mermaid", "é", {
      maxBytes: 1
    });
    assert.ok(inspected);
    assert.equal(inspected.bytes, 2);
    assert.equal(
      inspected.issues.some(
        (issue) => issue.code === "NMD_STATIC_NOTATION_BYTES_LIMIT"
      ),
      true
    );

    const parsed = parse(
      document(fence + "mermaid", "flowchart LR", "  A --> B", fence)
    );
    assert.ok(parsed.document);
    assert.deepEqual(parsed.diagnostics, []);
  } finally {
    globalThis.Buffer = buffer;
  }
});

test("Mermaid preflight rejects config, interaction, resources, and active markup", () => {
  const inspected = inspectStaticNotationFence(
    "mermaid",
    [
      "%%{init: {'securityLevel': 'loose'}}%%",
      "flowchart LR",
      "click A href \"https://example.org\"",
      "A[<img src='asset.png'>]",
      "B[<script>alert(1)</script>]"
    ].join("\n")
  );
  assert.ok(inspected);
  assert.equal(inspected.renderable, false);
  assert.deepEqual(
    new Set(inspected.issues.map((issue) => issue.code)),
    new Set([
      "NMD_MERMAID_CONFIG_FORBIDDEN",
      "NMD_MERMAID_INTERACTION_FORBIDDEN",
      "NMD_MERMAID_RESOURCE_FORBIDDEN",
      "NMD_MERMAID_MARKUP_FORBIDDEN"
    ])
  );
});

test("Vega-Lite preflight accepts an embedded values-only static chart", () => {
  const source = JSON.stringify({
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: [{ category: "A", value: 3 }] },
    mark: "bar",
    encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "value", type: "quantitative" }
    }
  });
  const inspected = inspectStaticNotationFence("vega-lite", source);
  assert.ok(inspected);
  assert.equal(inspected.renderable, true);
  assert.equal(inspected.nodes > 1, true);
  assert.deepEqual(inspected.issues, []);
});

test("Vega-Lite preflight rejects malformed JSON, remote data, bindings, config, and expressions", () => {
  assert.equal(
    inspectStaticNotationFence("vega-lite", "{").issues[0].code,
    "NMD_VEGA_JSON_INVALID"
  );
  const inspected = inspectStaticNotationFence(
    "vega-lite",
    JSON.stringify({
      data: { url: "https://example.org/data.json" },
      params: [{ name: "pick", bind: "scales" }],
      config: { background: "white" },
      encoding: { x: { axis: { labelExpr: "datum.label" } } }
    })
  );
  assert.equal(inspected.renderable, false);
  assert.deepEqual(
    new Set(inspected.issues.map((issue) => issue.code)),
    new Set([
      "NMD_VEGA_RESOURCE_FORBIDDEN",
      "NMD_VEGA_INTERACTION_FORBIDDEN",
      "NMD_VEGA_CONFIG_FORBIDDEN",
      "NMD_VEGA_EXPRESSION_FORBIDDEN"
    ])
  );
});

test("static preflight enforces explicit byte, line, depth, and node limits iteratively", () => {
  const byteLimited = inspectStaticNotationFence("mermaid", "abcdef", {
    maxBytes: 5
  });
  assert.equal(byteLimited.issues[0].code, "NMD_STATIC_NOTATION_BYTES_LIMIT");
  const lineLimited = inspectStaticNotationFence("mermaid", "a\nb\nc", {
    maxLines: 2
  });
  assert.equal(lineLimited.issues[0].code, "NMD_STATIC_NOTATION_LINES_LIMIT");

  const deep = '{"a":'.repeat(80) + "0" + "}".repeat(80);
  const depthLimited = inspectStaticNotationFence("vega-lite", deep, {
    maxDepth: 8,
    maxNodes: 1000
  });
  assert.equal(
    depthLimited.issues.some((issue) => issue.code === "NMD_STATIC_NOTATION_DEPTH_LIMIT"),
    true
  );
  const nodeLimited = inspectStaticNotationFence(
    "vega-lite",
    JSON.stringify({ data: { values: Array.from({ length: 20 }, (_, i) => ({ i })) } }),
    { maxNodes: 8 }
  );
  assert.equal(
    nodeLimited.issues.some((issue) => issue.code === "NMD_STATIC_NOTATION_NODES_LIMIT"),
    true
  );
});
