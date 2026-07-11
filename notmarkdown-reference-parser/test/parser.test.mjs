import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../dist/index.js";

const document = (...lines) => ["@notmarkdown 0.1", "", ...lines].join("\n");

test("parses headings, inline semantics, and canonical text", () => {
  const result = parse(
    document(
      "# Result {#result}",
      "",
      "This is **important** and *clear*.",
      "",
      "See [the result](#result)."
    )
  );
  assert.ok(result.document);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.document.children[0].type, "heading");
  assert.equal(result.document.children[0].id, "result");
  assert.equal(result.document.children[1].type, "paragraph");
  assert.equal(result.document.children[2].type, "paragraph");
});

test("uses the first ordered marker as start and requires later 1 markers", () => {
  const valid = parse(document("4. Fourth", "1. Fifth"));
  assert.ok(valid.document);
  assert.equal(valid.document.children[0].type, "list");
  assert.equal(valid.document.children[0].start, 4);

  const invalid = parse(document("4. Fourth", "5. Fifth"));
  assert.equal(invalid.document, undefined);
  assert.ok(
    invalid.diagnostics.some(
      (item) => item.code === "NMD_LIST_MARKER_NONCANONICAL"
    )
  );
});

test("parses media and typed caption attributes", () => {
  const result = parse(
    document(
      "!video[Demo](asset:demo) {",
      "  poster: asset:poster",
      "  captions.de: asset:captions-de",
      "}"
    )
  );
  assert.ok(result.document);
  const video = result.document.children[0];
  assert.equal(video.type, "video");
  assert.deepEqual(video.attributes.captions.de, {
    kind: "asset",
    id: "captions-de"
  });
});

test("parses nested lists with exactly two spaces", () => {
  const result = parse(document("- Outer", "  - Inner"));
  assert.ok(result.document);
  const list = result.document.children[0];
  assert.equal(list.type, "list");
  const nested = list.children[0].children[1];
  assert.equal(nested.type, "list");
});

test("rejects missing headers, ambiguous emphasis, and unresolved references", () => {
  const missing = parse("# Missing header");
  assert.ok(missing.diagnostics.some((item) => item.code === "NMD_HEADER_REQUIRED"));

  const emphasis = parse(document("This is ***ambiguous***."));
  assert.ok(
    emphasis.diagnostics.some(
      (item) => item.code === "NMD_INLINE_DELIMITER_AMBIGUOUS"
    )
  );

  const reference = parse(document("See [missing](#nowhere)."));
  assert.ok(
    reference.diagnostics.some(
      (item) => item.code === "NMD_REFERENCE_UNRESOLVED"
    )
  );
});

test("resolves footnotes and normalizes source line endings", () => {
  const source = document(
    "A statement.[^note]",
    "",
    "[^note]: Supporting text."
  ).replace(/\n/g, "\r\n");
  const result = parse(source);
  assert.ok(result.document);
  assert.equal(result.document.definitions.footnotes.note[0].type, "paragraph");
});

test("parses code fences without executing content", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const result = parse(document(fence + "js", "alert(1);", fence));
  assert.ok(result.document);
  const code = result.document.children[0];
  assert.equal(code.type, "codeBlock");
  assert.equal(code.language, "js");
  assert.equal(code.text, "alert(1);");
});
