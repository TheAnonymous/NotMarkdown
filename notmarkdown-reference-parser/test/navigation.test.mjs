import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSearchIndex,
  buildSearchIndexWithAssets,
  IncrementalSearchCache,
  outline,
  parse,
  searchDocument,
  searchIndex
} from "../dist/index.js";

test("derives outline paths and a disposable full-text index", async () => {
  const source = await readFile("examples/comprehensive.nmt", "utf8");
  const parsed = parse(source);
  assert.ok(parsed.document);

  const entries = outline(parsed.document);
  assert.deepEqual(
    entries.map((entry) => [entry.level, entry.title]),
    [
      [1, "Nodes"],
      [2, "Rich content"],
      [2, "Media"],
      [3, "Data views"]
    ]
  );
  assert.equal(entries[0].path, "/children/0");

  const index = buildSearchIndex(parsed.document);
  assert.equal(index.indexVersion, "0.2");
  assert.equal(index.documentModelVersion, "0.1");
  assert.deepEqual(index.omissions, []);
  const fallback = searchDocument(parsed.document, "demo-captions", 10);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].kind, "video");
  const diagram = searchDocument(parsed.document, "system flow", 10);
  assert.equal(diagram[0].kind, "diagram");
  assert.equal(diagram[0].section, "Data views");
});

test("indexes transcripts, WebVTT captions, and textual attachments", () => {
  const parsed = parse(
    [
      "@notmarkdown 0.1",
      "",
      "# Media",
      "",
      "!video[Demo](asset:demo) {",
      "  captions.en: asset:captions",
      "  transcript: asset:transcript",
      "}",
      "",
      "!attachment[Notes](asset:notes) {",
      "}"
    ].join("\n") + "\n"
  );
  assert.ok(parsed.document);
  const bytes = (value) => new TextEncoder().encode(value);
  const index = buildSearchIndexWithAssets(parsed.document, [
    {
      id: "captions",
      packagePath: "assets/captions.vtt",
      mediaType: "text/vtt",
      data: bytes(
        "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<c.green>Spoken ocean turbine</c>\n"
      )
    },
    {
      id: "demo",
      packagePath: "assets/demo.webm",
      mediaType: "video/webm",
      data: bytes("binary words are not indexed")
    },
    {
      id: "notes",
      packagePath: "assets/notes.txt",
      mediaType: "text/plain",
      data: bytes("Calibration appendix")
    },
    {
      id: "transcript",
      packagePath: "assets/transcript.txt",
      mediaType: "text/plain",
      data: bytes("Silent magnetic bearing")
    }
  ]);
  assert.equal(index.entries.filter((entry) => entry.origin === "asset").length, 3);
  const caption = searchIndex(index, "spoken ocean", 10);
  assert.equal(caption[0].kind, "captions");
  assert.equal(caption[0].assetId, "captions");
  assert.equal(caption[0].context, "Spoken ocean turbine");
  const attachment = searchIndex(index, "calibration appendix", 10);
  assert.equal(attachment[0].kind, "attachmentText");
  assert.equal(attachment[0].path, "/children/2");
  assert.deepEqual(searchIndex(index, "binary words", 10), []);
});

test("reports invalid UTF-8 and bounded asset omissions deterministically", () => {
  const parsed = parse(
    "@notmarkdown 0.1\n\n!attachment[Notes](asset:notes) {\n}\n"
  );
  assert.ok(parsed.document);
  const index = buildSearchIndexWithAssets(parsed.document, [
    {
      id: "notes",
      packagePath: "assets/invalid.txt",
      mediaType: "text/plain",
      data: Uint8Array.of(0xff)
    },
    {
      id: "notes",
      packagePath: "assets/oversized.txt",
      mediaType: "text/plain",
      data: new Uint8Array(8 * 1024 * 1024 + 1)
    }
  ]);
  assert.deepEqual(index.omissions, [
    {
      assetId: "notes",
      packagePath: "assets/invalid.txt",
      reason: "invalidUtf8"
    },
    {
      assetId: "notes",
      packagePath: "assets/oversized.txt",
      reason: "sizeLimit"
    }
  ]);
});

test("incremental cache reuses unchanged assets and invalidates only changes", () => {
  const source = (heading) =>
    [
      "@notmarkdown 0.1",
      "",
      "# " + heading,
      "",
      "!video[Demo](asset:demo) {",
      "  captions.en: asset:captions",
      "  transcript: asset:transcript",
      "}"
    ].join("\n") + "\n";
  const firstDocument = parse(source("Media")).document;
  assert.ok(firstDocument);
  const bytes = (value) => new TextEncoder().encode(value);
  const assets = [
    {
      id: "captions",
      packagePath: "assets/captions.vtt",
      mediaType: "text/vtt",
      fingerprint: "captions-sha",
      data: bytes("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOcean current\n")
    },
    {
      id: "transcript",
      packagePath: "assets/transcript.txt",
      mediaType: "text/plain",
      fingerprint: "transcript-sha-1",
      data: bytes("Silent bearing")
    }
  ];
  const cache = new IncrementalSearchCache();
  const first = cache.update(firstDocument, "source-1", assets);
  assert.equal(first.stats.documentReused, false);
  assert.equal(first.stats.assetsReindexed, 2);
  assert.equal(first.stats.assetsReused, 0);

  const second = cache.update(firstDocument, "source-1", assets);
  assert.equal(second.stats.documentReused, true);
  assert.equal(second.stats.assetsReindexed, 0);
  assert.equal(second.stats.assetsReused, 2);
  assert.deepEqual(second.index, first.index);

  const changedDocument = parse(source("Updated media")).document;
  assert.ok(changedDocument);
  const moved = cache.update(changedDocument, "source-2", assets);
  assert.equal(moved.stats.documentReused, false);
  assert.equal(moved.stats.assetsReused, 2);
  assert.equal(searchIndex(moved.index, "silent bearing", 1)[0].section, "Updated media");

  const changedAssets = [
    assets[0],
    {
      ...assets[1],
      fingerprint: "transcript-sha-2",
      data: bytes("Modular generator housing")
    }
  ];
  const changed = cache.update(changedDocument, "source-2", changedAssets);
  assert.equal(changed.stats.documentReused, true);
  assert.equal(changed.stats.assetsReused, 1);
  assert.equal(changed.stats.assetsReindexed, 1);
  assert.equal(searchIndex(changed.index, "modular generator", 1)[0].assetId, "transcript");

  const prunedDocument = parse(
    "@notmarkdown 0.1\n\n# Updated media\n\n!video[Demo](asset:demo) {\n  transcript: asset:transcript\n}\n"
  ).document;
  assert.ok(prunedDocument);
  const pruned = cache.update(prunedDocument, "source-3", changedAssets);
  assert.equal(pruned.stats.assetsRemoved, 1);
  assert.equal(pruned.stats.assetsReused, 1);
});

test("parses visible table-of-contents placement without materializing entries", () => {
  const parsed = parse(
    ["@notmarkdown 0.1", "", "# Heading", "", "!toc{depth=3}"].join("\n")
  );
  assert.ok(parsed.document);
  assert.deepEqual(parsed.document.children[1], {
    type: "tableOfContents",
    maxDepth: 3
  });

  const malformed = parse("@notmarkdown 0.1\n\n!toc{depth=9}\n");
  assert.equal(malformed.document, undefined);
  assert.equal(malformed.diagnostics[0].code, "NMD_TOC_SYNTAX");
});
