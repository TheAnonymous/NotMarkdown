import assert from "node:assert/strict";
import test from "node:test";
import {
  createPackage,
  inferMediaType,
  openPackage,
  PackageFormatError,
  readZip,
  writeZip,
  ZipFormatError
} from "../dist/index.js";

const source = [
  "@notmarkdown 0.1",
  "",
  "# Package",
  "",
  "![Diagram](asset:diagram){layout=wide}"
].join("\n");

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><text>NotMarkdown</text></svg>'
);

function packageWith(profile) {
  return createPackage({
    source,
    profile,
    assets: [
      {
        id: "diagram",
        fileName: "diagram.svg",
        mediaType: "image/svg+xml",
        data: svg
      }
    ]
  });
}

test("modern packages are deterministic and use Zstandard for text", () => {
  const first = packageWith("modern-0.1");
  const second = packageWith("modern-0.1");
  assert.deepEqual(first, second);

  const opened = openPackage(first);
  assert.equal(opened.manifest.containerProfile, "modern-0.1");
  assert.equal(opened.entries.get("manifest.json").compression, "zstd");
  assert.equal(opened.entries.get("document.nmt").compression, "zstd");
  assert.equal(opened.entries.get("assets/diagram.svg").compression, "zstd");
  assert.equal(opened.source.endsWith("\n"), true);
});

test("portable packages use Deflate for compressible entries", () => {
  const opened = openPackage(packageWith("portable-0.1"));
  assert.equal(opened.entries.get("manifest.json").compression, "deflate");
  assert.equal(opened.entries.get("document.nmt").compression, "deflate");
  assert.equal(opened.entries.get("assets/diagram.svg").compression, "deflate");
});

test("already compressed media is stored without a second codec", () => {
  const bytes = Buffer.from([12, 34, 56, 78, 90, 123, 210]);
  const input = createPackage({
    source: [
      "@notmarkdown 0.1",
      "",
      "![Photo](asset:photo)"
    ].join("\n"),
    assets: [
      {
        id: "photo",
        fileName: "photo.avif",
        data: bytes
      }
    ]
  });
  const opened = openPackage(input);
  assert.equal(opened.entries.get("assets/photo.avif").compression, "store");
  assert.deepEqual(opened.entries.get("assets/photo.avif").data, bytes);
});

test("packing rejects missing and unused assets", () => {
  assert.throws(
    () => createPackage({ source }),
    (error) =>
      error instanceof PackageFormatError && error.code === "NMD_ASSET_MISSING"
  );
  assert.throws(
    () =>
      createPackage({
        source: ["@notmarkdown 0.1", "", "No assets."].join("\n"),
        assets: [
          {
            id: "unused",
            fileName: "unused.txt",
            data: Buffer.from("unused")
          }
        ]
      }),
    (error) =>
      error instanceof PackageFormatError && error.code === "NMD_ASSET_UNUSED"
  );
});

test("the reader rejects tampering and configured resource-limit violations", () => {
  const media = Buffer.from([101, 102, 103, 104, 105, 106, 107]);
  const packed = createPackage({
    source: ["@notmarkdown 0.1", "", "![Photo](asset:photo)"].join("\n"),
    assets: [{ id: "photo", fileName: "photo.avif", data: media }]
  });
  const tampered = Buffer.from(packed);
  const location = tampered.indexOf(media);
  assert.notEqual(location, -1);
  tampered[location] ^= 0xff;
  assert.throws(
    () => openPackage(tampered),
    (error) =>
      error instanceof PackageFormatError &&
      error.code === "NMD_ZIP_CRC_MISMATCH"
  );
  assert.throws(
    () => openPackage(packed, { maxTotalBytes: 8 }),
    (error) =>
      error instanceof PackageFormatError &&
      error.code === "NMD_ZIP_TOTAL_SIZE_LIMIT"
  );
});

test("the ZIP layer rejects path traversal and duplicate paths", () => {
  assert.throws(
    () =>
      writeZip([
        {
          path: "../escape",
          data: Buffer.from("x"),
          compression: "store"
        }
      ]),
    (error) =>
      error instanceof ZipFormatError && error.code === "NMD_ZIP_PATH_UNSAFE"
  );
  assert.throws(
    () =>
      writeZip([
        { path: "same", data: Buffer.from("a"), compression: "store" },
        { path: "same", data: Buffer.from("b"), compression: "store" }
      ]),
    (error) =>
      error instanceof ZipFormatError && error.code === "NMD_ZIP_DUPLICATE"
  );
});

test("ZIP round trips all three permitted compression methods", () => {
  const archive = writeZip([
    { path: "stored.bin", data: Buffer.from("stored"), compression: "store" },
    {
      path: "deflated.txt",
      data: Buffer.from("deflated ".repeat(20)),
      compression: "deflate"
    },
    {
      path: "zstandard.txt",
      data: Buffer.from("zstandard ".repeat(20)),
      compression: "zstd"
    }
  ]);
  const entries = readZip(archive);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].data.toString(), "stored");
  assert.equal(entries[1].data.toString(), "deflated ".repeat(20));
  assert.equal(entries[2].data.toString(), "zstandard ".repeat(20));
});

test("infers Mermaid, draw.io, compound draw.io SVG, and Vega-Lite media types", () => {
  assert.equal(inferMediaType("flow.mmd"), "text/vnd.mermaid");
  assert.equal(inferMediaType("flow.mermaid"), "text/vnd.mermaid");
  assert.equal(inferMediaType("model.drawio"), "application/vnd.jgraph.mxfile");
  assert.equal(inferMediaType("model.dio"), "application/vnd.jgraph.mxfile");
  assert.equal(inferMediaType("model.drawio.svg"), "image/svg+xml");
  assert.equal(inferMediaType("latency.vl.json"), "application/vnd.vegalite+json");
  assert.equal(inferMediaType("latency.vegalite.json"), "application/vnd.vegalite+json");
});

test("packages static visual assets with semantic kind, role, MIME, and compound suffix", () => {
  const visualSource = [
    "@notmarkdown 0.1",
    "",
    "!diagram[Architecture] {",
    "  type: architecture",
    "  source: asset:architecture",
    "}",
    "",
    "!chart[Latency] {",
    "  type: line",
    "  data: asset:latency",
    "}"
  ].join("\n");
  const packed = createPackage({
    source: visualSource,
    assets: [
      {
        id: "architecture",
        fileName: "architecture.drawio.svg",
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
      },
      {
        id: "latency",
        fileName: "latency.vl.json",
        mediaType: "application/vnd.vegalite.v6+json",
        data: Buffer.from('{"data":{"values":[]},"mark":"line"}')
      }
    ]
  });
  const manifest = openPackage(packed).manifest;
  assert.deepEqual(manifest.assets.architecture, {
    kind: "diagram",
    representations: [
      {
        path: "assets/architecture.drawio.svg",
        mediaType: "image/svg+xml",
        role: "source",
        bytes: manifest.assets.architecture.representations[0].bytes,
        sha256: manifest.assets.architecture.representations[0].sha256
      }
    ]
  });
  assert.equal(manifest.assets.latency.kind, "data");
  assert.equal(manifest.assets.latency.representations[0].role, "data");
  assert.equal(manifest.assets.latency.representations[0].path, "assets/latency.vl.json");
  assert.equal(
    manifest.assets.latency.representations[0].mediaType,
    "application/vnd.vegalite.v6+json"
  );

  const v5 = createPackage({
    source: "@notmarkdown 0.1\n\n!chart[V5] {\n  type: bar\n  data: asset:v5\n}\n",
    assets: [
      {
        id: "v5",
        fileName: "v5.json",
        mediaType: "application/vnd.vegalite.v5+json",
        data: Buffer.from('{"data":{"values":[]},"mark":"bar"}')
      }
    ]
  });
  assert.equal(openPackage(v5).manifest.assets.v5.kind, "data");
  assert.equal(openPackage(v5).manifest.assets.v5.representations[0].role, "data");
});

test("the package reader rejects manifest paths with dot or empty segments", () => {
  const cleanSource = Buffer.from("@notmarkdown 0.1\n\nNo assets.\n");
  const manifest = {
    format: "notmarkdown",
    packageVersion: "0.1",
    source: "document.nmt",
    sourceSha256: "0".repeat(64),
    containerProfile: "modern-0.1",
    themeProfile: "0.1",
    mediaProfile: "2026-draft",
    assets: {
      bad: {
        kind: "diagram",
        representations: [
          {
            path: "assets/../escape.drawio",
            mediaType: "application/vnd.jgraph.mxfile",
            role: "source",
            bytes: 1,
            sha256: "0".repeat(64)
          }
        ]
      }
    }
  };
  const archive = writeZip([
    {
      path: "mimetype",
      data: Buffer.from("application/vnd.notmarkdown.document+zip"),
      compression: "store"
    },
    {
      path: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest) + "\n"),
      compression: "zstd"
    },
    { path: "document.nmt", data: cleanSource, compression: "zstd" }
  ]);
  assert.throws(
    () => openPackage(archive),
    (error) =>
      error instanceof PackageFormatError &&
      error.code === "NMD_MANIFEST_REPRESENTATION_INVALID"
  );
});
