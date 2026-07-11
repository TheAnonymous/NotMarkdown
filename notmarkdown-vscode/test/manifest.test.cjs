const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

test("extension declares both source and package surfaces", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", `file://${__filename}`)));
  assert.equal(manifest.contributes.languages[0].id, "notmarkdown");
  assert.equal(manifest.contributes.customEditors[0].viewType, "notmarkdown.package");
  assert.ok(manifest.contributes.commands.some((item) => item.command === "notmarkdown.verify"));
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.contributes.snippets[0].path, "./snippets/notmarkdown.json");
});

test("static visual fences and snippets are declared without scripts", () => {
  const grammar = JSON.parse(readFileSync(new URL("../syntaxes/notmarkdown.tmLanguage.json", `file://${__filename}`)));
  const snippets = JSON.parse(readFileSync(new URL("../snippets/notmarkdown.json", `file://${__filename}`)));
  const begins = grammar.patterns.map((item) => item.begin).filter(Boolean);
  assert.ok(begins.includes("^```(mermaid)$"));
  assert.ok(begins.includes("^```(vega-lite|vegalite)$"));
  assert.ok(snippets["Mermaid diagram"]);
  assert.ok(snippets["Vega-Lite chart"]);
  assert.ok(snippets["draw.io diagram directive"]);
});
