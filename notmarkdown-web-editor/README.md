# NotMarkdown Studio 0.7

Browser-first editor prototype for NotMarkdown. It keeps one local document
session synchronized across three views:

- **Document** — constrained visual editing with semantic formatting;
- **Source** — the authoritative `document.nmt` text with diagnostics;
- **Package** — metadata, embedded assets, generated session previews, and the
  selected container profile.

The editor runs locally in the browser. Opening, editing, previewing, packing,
and unpacking do not require a server API.

## Implemented in 0.7

- lossless, exact-lowercase `mermaid`, `vega-lite`, and `vegalite` source
  fences with atomic Document-view previews, direct source editing, and toolbar
  insertion;
- pinned, lazy Mermaid 11.16.0 and Vega/Vega-Lite 6.2.0/6.4.3 rendering;
- strict offline preflight, bounded values-only charts, a fixed visual theme,
  render timeouts, concurrency limits, and a per-document automatic budget;
- DOMPurify sanitization followed by a Blob-backed image boundary, so generated
  SVG is never inserted as document-global inline markup;
- accessible bounded data tables for chart previews;
- draw.io, editable draw.io SVG, Mermaid source, and Vega-Lite asset inference,
  including compound filenames and canonical media roles;
- lossless multi-representation assets across eager/range open and deterministic
  save, with safe draw.io SVG preview selection and per-representation
  load/extract/replace controls;
- pre-load authoring limits and bounded UTF-8/XML validation for draw.io source
  and SVG representations;
- a restrictive application Content Security Policy as defense in depth.

Append `?embed=1` when Studio is hosted inside the NotMarkdown landing page.
Embed mode retains the real editor and file workflow while adapting the shell
to compact viewports. Opening Studio as a top-level page remains the best route
for native save-file picker support.

## Requirements

- Node.js 22 or newer
- the sibling `notmarkdown-reference-parser` directory

## Develop

```sh
npm install
npm run dev
```

Vite prints the local URL. Open that URL in a current browser.

## Verify and build

```sh
npm run check
```

The production site is written to `dist/`. Serve that directory from a web
server at its root; HTTPS is recommended for installation as a browser app.

## Implemented in 0.6.2

- progressive OS file handling for installed PWAs: `.nmdoc` and `.nmt` are
  declared in the web app manifest and consumed through `launchQueue`;
- local Web Share Target intake for `.nmdoc` and `.nmt`: the service worker
  accepts the operating-system share, keeps one pending file temporarily in
  origin-private Cache Storage, and deletes it as Studio consumes it;
- one extension-checked intake path for the file picker, drag/drop, OS file
  launch, and share target; arbitrary shared or dropped files are rejected;
- visible capability status distinguishes system-open/native-save support from
  picker, drag/drop, and download fallbacks;
- relative PWA identity, start URL, scope, handlers, share target, and a
  maskable vector icon so subdirectory deployments remain portable;
- all supported intake remains on device. The active service worker handles the
  share-target POST locally; Studio defines no upload endpoint and does not
  forward document bytes to an application server.

The manifest uses `application/vnd.notmarkdown.document+zip` for `.nmdoc`. It
uses the provisional, not yet IANA-registered
`text/vnd.notmarkdown.source` for `.nmt`, with `text/plain` as an explicit
compatibility association.

PWA file associations and share targets only become available after the browser
installs Studio and are not implemented by every browser/operating-system pair.
The **Open** button and drag/drop always remain available; save falls back to a
local download when the native save picker is unavailable.

## Implemented in 0.6.1

- first-class landing-page embed mode with an accessible compact tab bar;
- responsive Studio chrome and document canvas down to narrow viewports;

## Implemented in 0.6

- deterministic ZIP32 streaming writer with an abortable byte-sink contract;
- atomic native save through the browser File System Access API where
  available, with the existing download path as a compatibility fallback;
- two-pass asset integrity: CRC-32, byte length, and SHA-256 are established
  before output and checked again while stored media streams to disk;
- large already-compressed media writes in bounded chunks without buffering the
  asset or final archive; compressible content buffers at most one entry;
- lazy imported `File` assets backed by reusable streams rather than immediate
  `ArrayBuffer` copies;
- incremental SHA-256 through the audited zero-dependency `@noble/hashes`
  implementation;

- range-based `.nmdoc` opening: the browser reads the ZIP tail, central
  directory, local headers, manifest, and source without buffering a large
  archive as one `ArrayBuffer`;
- deferred binary assets with manifest byte lengths visible immediately;
- CRC-32 and SHA-256 verification at the asset access boundary, before preview,
  extraction, search indexing, or package rewriting can consume bytes;
- on-demand media previews and extraction, with loaded/deferred state in the
  Package view;
- bounded textual-representation loading on the first package-wide search;
- range-read telemetry in the open confirmation, making large-package behavior
  observable rather than implicit;
- ProseMirror document view with paragraphs, headings, strong/emphasis/code,
  quotations, ordered lists, unordered lists, undo, and redo;
- always-available automatic outline and local full-text search in the Document
  view, with direct navigation to CDM paths;
- package-wide search over embedded UTF-8 captions, transcripts, and textual
  attachments, with asset identity and safe size-limit omissions;
- lazy incremental search caching: the first query decodes changed text assets,
  later queries reuse them by session/SHA-256 fingerprint and display cache
  reuse versus rebuild counts;
- rendered `!toc` blocks whose entries update from headings automatically;
- automatically calculated ordered-list numbering;
- CodeMirror source view with NotMarkdown highlighting and parser diagnostics;
- package view for metadata, assets, extraction, removal, generated previews,
  and profile selection;
- local open and drag/drop for `.nmt` and `.nmdoc`;
- local download of `.nmt` and `.nmdoc`;
- audio and video playback controls without autoplay;
- deterministic `portable-0.1` Deflate packages;
- deterministic `modern-0.1` ZIP method-93 Zstandard packages via WebAssembly;
- CRC-32, SHA-256, path, header, size, count, and compression-ratio checks;
- manifest and service worker for installable/offline browser use;
- lazy-loaded editor views so the initial application stays smaller;
- interoperability tests in both directions with the Node reference toolchain.

## Editing model

`document.nmt` remains the stored authority. A valid source update becomes the
current canonical document tree. An invalid source update stays visible in the
source editor, while the document view keeps showing the last valid tree and
package saving is disabled. Visual edits serialize back to valid, normalized
NotMarkdown source.

The package view owns imported binary data. Source references use stable
`asset:id` identifiers rather than internal filenames. A package cannot be
saved while a referenced asset is missing or an embedded asset is unused.

## Deliberate prototype limits

- Browsers without the native save picker still need a final in-memory Blob for
  download; the UI labels that path as a compatibility fallback.
- Generated previews are session caches and are not persisted as authoritative
  content.
- The visual editor covers the implemented parser subset. Source remains the
  escape hatch for supported structures without a visual control.
- Tables, citations, an embedded draw.io canvas, ZIP64, and signatures remain
  later milestones. Editable draw.io files currently use Extract → edit in
  diagrams.net/draw.io → Replace.

No scripts, macros, notebook cells, interactive forms, arbitrary HTML, or
arbitrary visual layout are supported.
