# NotMarkdown reference toolchain 0.6

This is the executable reference toolchain for the NotMarkdown 0.1 draft. It
has no runtime dependencies and implements parsing plus the single-file
container.

## Requirements

- Node.js 22 or newer
- npm for development builds

## Build and test

~~~sh
npm install
npm test
~~~

## CLI

~~~sh
npm run build
node dist/cli.js parse examples/basic.nmt
node dist/cli.js outline examples/comprehensive.nmt
node dist/cli.js index document.nmdoc
node dist/cli.js search document.nmdoc "spoken captions"
~~~

Create a modern Zstandard package:

~~~sh
node dist/cli.js pack document.nmt \
  --output document.nmdoc \
  --profile modern \
  --asset photo=photo.avif
~~~

Inspect and unpack it:

~~~sh
node dist/cli.js inspect document.nmdoc
node dist/cli.js unpack document.nmdoc --output unpacked
~~~

Use the portable profile when compatibility with conventional ZIP readers is
more important than modern text compression:

~~~sh
node dist/cli.js pack document.nmt --profile portable
~~~

## Library API

~~~js
import {
  buildSearchIndex,
  buildSearchIndexWithAssets,
  createPackage,
  IncrementalSearchCache,
  inspectStaticNotationFence,
  openPackage,
  outline,
  parse
} from "@notmarkdown/reference-toolchain";

const result = parse(source);
if (result.document) {
  console.log(result.document);
} else {
  console.error(result.diagnostics);
}
~~~

## Implemented

- mandatory version header and document metadata;
- headings with explicit IDs;
- paragraphs and normalized line endings;
- strong text, emphasis, code spans, links, cross-references, and footnotes;
- ordered, unordered, task, and nested lists;
- quotations and fenced code;
- lossless `mermaid`, `vega-lite`, and `vegalite` code fences with bounded,
  offline-only static-render preflight and searchable source;
- image, audio, and video blocks;
- typed media attributes and caption languages;
- diagram, chart, math, and attachment shell nodes;
- structured diagnostics with source ranges and repair suggestions;
- duplicate-ID and unresolved-reference validation.
- automatic outline, disposable package-wide full-text index, ranked search,
  and `!toc`;
- bounded UTF-8 indexing for verified captions, transcripts, and textual
  attachments, including deterministic WebVTT cleanup and omission reporting;
- incremental document/asset cache reuse with explicit source and SHA-256
  fingerprints, per-asset invalidation, pruning, and update statistics;
- deterministic single-file packages;
- portable Deflate and modern Zstandard container profiles;
- uncompressed storage for already-compressed media;
- canonical manifests with SHA-256 hashes;
- semantic MIME, kind, role, and compound-suffix inference for Mermaid,
  draw.io, editable draw.io SVG, and Vega-Lite assets;
- CRC-32, header, size, path, duplicate, and resource-limit checks;
- pack, unpack, inspect, parse, outline, index, and search commands.

## Deliberate current limits

- Tables and citation syntax await their detailed 0.1 specifications.
- Extension nodes are reserved but not materialized yet.
- Local paths must be imported into asset IDs before canonical parsing.
- ZIP64 and packages larger than 4 GiB await a later container profile.
- Source maps for transformed quotation and list content are approximate.
- Static visual preflight is deliberately conservative: configuration,
  interactions, expressions, and external resources remain inert source and
  are not eligible for preview.

The parser rejects unsupported or ambiguous input rather than silently choosing
implementation-specific behavior.
