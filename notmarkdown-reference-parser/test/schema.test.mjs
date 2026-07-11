import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createPackage, openPackage, parse } from "../dist/index.js";

test("the example parser outputs conform to the CDM JSON Schema", async () => {
  const schema = JSON.parse(
    await readFile("../notmarkdown-cdm-0.1.schema.json", "utf8")
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  for (const path of ["examples/basic.nmt", "examples/comprehensive.nmt"]) {
    const source = await readFile(path, "utf8");
    const result = parse(source);
    assert.ok(result.document);
    const valid = validate(result.document);
    assert.equal(
      valid,
      true,
      path + ": " + JSON.stringify(validate.errors, null, 2)
    );
  }
});

test("parser output for every document theme conforms to the CDM JSON Schema", async () => {
  const schema = JSON.parse(
    await readFile("../notmarkdown-cdm-0.1.schema.json", "utf8")
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const themes = [
    "standard",
    "paper",
    "technical",
    "minimal",
    "sepia",
    "midnight",
    "high-contrast"
  ];

  for (const theme of themes) {
    const result = parse(
      [
        "@notmarkdown 0.1",
        "",
        "@document {",
        `  theme: ${theme}`,
        "}",
        "",
        "# Themed document"
      ].join("\n")
    );
    assert.ok(result.document, theme);
    assert.equal(
      validate(result.document),
      true,
      theme + ": " + JSON.stringify(validate.errors, null, 2)
    );
  }
});

test("generated manifests conform to the manifest JSON Schema", async () => {
  const schema = JSON.parse(
    await readFile("../notmarkdown-manifest-0.1.schema.json", "utf8")
  );
  const source = [
    "@notmarkdown 0.1",
    "",
    "![Example](asset:example)"
  ].join("\n");
  const packed = createPackage({
    source,
    assets: [
      {
        id: "example",
        fileName: "example.avif",
        data: Buffer.from([1, 2, 3, 4])
      }
    ]
  });
  const manifest = openPackage(packed).manifest;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const valid = validate(manifest);
  assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
});

test("the CDM chart data contract accepts references but rejects arbitrary objects", async () => {
  const schema = JSON.parse(
    await readFile("../notmarkdown-cdm-0.1.schema.json", "utf8")
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const parsed = parse(
    "@notmarkdown 0.1\n\n!chart[Latency] {\n  type: line\n  data: asset:latency\n}\n"
  );
  assert.ok(parsed.document);
  assert.equal(validate(parsed.document), true);
  const invalid = structuredClone(parsed.document);
  invalid.children[0].data = { values: [] };
  assert.equal(validate(invalid), false);
});

test("the manifest schema rejects dot and empty path segments", async () => {
  const schema = JSON.parse(
    await readFile("../notmarkdown-manifest-0.1.schema.json", "utf8")
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const base = {
    format: "notmarkdown",
    packageVersion: "0.1",
    source: "document.nmt",
    sourceSha256: "0".repeat(64),
    containerProfile: "modern-0.1",
    themeProfile: "0.1",
    mediaProfile: "2026-draft",
    assets: {
      visual: {
        kind: "diagram",
        representations: [
          {
            path: "assets/visual.drawio.svg",
            mediaType: "image/svg+xml",
            role: "source",
            bytes: 1,
            sha256: "1".repeat(64)
          }
        ]
      }
    }
  };
  assert.equal(validate(base), true);
  for (const path of ["assets/../escape.svg", "assets//empty.svg", "assets/./dot.svg"]) {
    const invalid = structuredClone(base);
    invalid.assets.visual.representations[0].path = path;
    assert.equal(validate(invalid), false, path);
  }
});
