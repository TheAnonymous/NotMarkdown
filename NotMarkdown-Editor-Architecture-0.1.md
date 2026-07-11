# NotMarkdown Editor Architecture 0.1

Status: implemented browser/core vertical slices and local adoption scaffolds  
Date: 2026-07-11

## 1. Product boundary

The editor family covers static documents only. It intentionally does not grow
into a presentation tool, executable notebook, web application builder,
interactive-document runtime, or free-form desktop-publishing system.

Every editor exposes the same three concepts:

1. **Document view** — readable, semantic editing with constrained formatting.
2. **Source view** — the authoritative `document.nmt` text.
3. **Package view** — metadata, assets, representations, and generated caches.

The capabilities adapt to the host. A terminal can represent an image or video
as a labeled asset, metadata, optional poster, captions, and transcript without
pretending it can render the media everywhere.

## 2. Implemented browser slice

`notmarkdown-web-editor` is a local-first browser application and progressive
web app. Its production build is static and does not require an application
server or cloud account.

```text
React application shell
    |
    +-- Document view (ProseMirror)
    +-- Source view (CodeMirror)
    +-- Package view (React components)
    |
    +-- Document session
            |
            +-- NotMarkdown parser and canonical tree
            +-- Range ZIP reader + deterministic in-memory writer
            +-- Lazy verified asset store and on-demand object-URL previews
            +-- Deflate codec + Zstandard WebAssembly codec
```

The views are code-split and loaded on demand. Package creation and opening are
also loaded only when invoked.

### 2.1 Document session invariant

The source text is the persistence authority. The in-memory session tracks:

- current source text;
- last valid canonical document tree;
- structured diagnostics for the current source;
- embedded asset descriptors, optional verified bytes, and derived local
  preview URLs;
- bounded derived search cache keyed by current source identity and verified
  representation fingerprints;
- filename and selected package profile.

When source parses successfully, the canonical tree advances. When it does not,
the source and its diagnostics remain editable, the last valid document stays
renderable, and package export is blocked. This prevents a half-parsed state
from silently destroying content.

Visual changes are converted into canonical source and pass back through the
same parser. Metadata changes in the package view rewrite the metadata block
and follow the same path. There is no second hidden document format.

### 2.2 Browser package codec

The browser implements the constrained `.nmdoc` container directly:

- method 0 for uncompressed entries;
- method 8 Deflate for `portable-0.1`;
- method 93 Zstandard through WebAssembly for `modern-0.1`;
- deterministic entry order, timestamps, names, and JSON;
- CRC-32 for ZIP entries and SHA-256 for source/assets;
- local/central-header agreement and resource-limit checks;
- rejection of unsafe paths, duplicate or undeclared entries, unknown flags,
  unsupported compression, and integrity mismatches.

Studio 0.6.2 opens browser `File`/`Blob` inputs through byte ranges. Initial open
reads the ZIP tail, central directory, all local headers, mimetype, manifest,
and source. Large binary payloads stay in the original Blob until preview,
extraction, package-wide text search, or save requires them. Each loader is
memoized and releases bytes only after expanded length, CRC-32, and manifest
SHA-256 agree. The package UI distinguishes loaded from deferred assets, and
the open notification reports bytes read versus archive size.

This is progressive validation: package structure and source can be verified
while representations remain declared but not yet verified. A corrupt deferred
asset cannot reach a preview, search index, extraction, or writer.

Studio 0.6 also implements a two-pass deterministic streaming writer. Preflight
establishes every representation's length, CRC-32, and SHA-256 before output.
Stored media then streams in bounded chunks to an abortable native file sink
and is checked again during the write. Compressible content buffers at most one
entry because its packed size is required in the local header. Browsers without
the native save picker retain the final-Blob download as a labeled compatibility
fallback.

Studio 0.6.1 also defines a first-class landing-page embed mode. The embedded
surface is the complete application, not a separate demo editor. Production
assets, web manifest, and service-worker entry points resolve relative to the
Studio directory so hosting below a subpath remains valid. Compact chrome keeps
Document, Source, Package, Open, and package Save reachable without horizontal
overflow; a top-level launch remains available for the strongest native
save-picker support.

Studio 0.6.2 adds one guarded intake path for the file picker, drag/drop,
installed-PWA file launches, and operating-system shares. The web manifest
declares `.nmdoc` and `.nmt` file handlers where the browser and operating
system support them. A local Web Share Target accepts one supported file into
origin-private Cache Storage; the service worker never uploads it and removes
the pending copy when Studio consumes it. Foreign extensions are rejected, and
the ordinary Open button, drag/drop, native-save picker, and download fallback
remain visibly available when an integration API is absent.

Automated tests prove that browser-generated modern packages open in the Node
reference toolchain and that a Node-generated modern package opens in the
browser codec.

### 2.3 Media behavior

Images render inline. Audio and video use native playback controls and never
autoplay. The package view derives local previews from embedded bytes. These
previews are caches, not authoritative document content. Unsupported terminal
or browser codecs must still leave the asset, label, metadata, transcript,
captions, and fallback representations inspectable.

### 2.4 Host associations

Browser associations are conveniences, not format requirements. Installation,
file-handler, launch-queue, and share-target support varies by browser and
operating system, so Studio cannot rely on any one of them as its only route to
a document.

The repository also contains reviewable platform-integration scaffolds:

- proposed MIME declarations for `.nmdoc` and `.nmt` with deterministic package
  magic matching;
- a Linux shared-mime-info definition, desktop-entry template, packaging notes,
  and source icon;
- an IANA media-type registration draft that is explicitly neither submitted
  nor approved.

These files do not register anything on a user's machine by themselves.
Windows ProgID/MSIX, macOS UTType/Quick Look, thumbnailing, and indexing remain
future packaging work after stable application identifiers and signing
identities exist. Preview and indexing helpers must stay read-only,
resource-limited, and unable to execute document content.

## 3. Shared-core direction

The TypeScript browser slice validates product behavior quickly. A durable
cross-platform core now exists as a small Rust workspace:

```text
notmarkdown-core       parser, canonical model, diagnostics, validation
notmarkdown-package    metadata-first ZIP access, streaming verification, limits
notmarkdown-render     semantic render tree and theme tokens
notmarkdown-cli        parse, pack, unpack, inspect, semantic diff; later optimize
notmarkdown-lsp        diagnostics, outline, hover, completion over stdio
notmarkdown-tui        terminal editor
notmarkdown-desktop    Tauri commands around the shared core
notmarkdown-wasm       browser bindings for core/package operations
```

The canonical tree and diagnostics are the contract. UI frameworks do not own
format semantics. Cross-implementation fixtures remain mandatory during the
transition so a Rust or WebAssembly rewrite cannot drift from 0.1 behavior.

### 3.1 Conformance kit

`conformance/` is an implemented, language-neutral test scaffold rather than a
second specification. It contains JSON Schema 2020-12 contracts, a JSON Lines
adapter protocol, a dependency-free metadata validator, fixtures, and an
ordered suite. Eight active cases cover established source behavior, bounded
CommonMark import, invalid UTF-8 rejection, and deterministic packages. Three
draft cases reserve adversarial ZIP mutation targets without treating an
unfinished neutral mutation harness as conformance.

Adapters advertise capabilities and report unsupported operations as skips.
Assertions compare structured values, exact bytes, and stable diagnostic codes,
not implementation-specific prose. Runs are offline and never execute code,
follow remote links, or extract untrusted paths. Read-only Node and Rust CI
workflow templates exercise the suite on Linux, macOS, and Windows once the
repository is published to a compatible CI host.

### 3.2 Compatibility Kit 0.1 local slice

The implemented Rust 0.11 adoption layer is a thin Compatibility Kit around the
existing core:

- explicit CommonMark/GFM import into NotMarkdown source or packages;
- constrained Markdown and inert standalone HTML export;
- machine-readable loss reports whenever a target cannot preserve semantics;
- Git text conversion and an opt-in local configuration helper so `.nmdoc`
  changes remain reviewable without committing extracted package directories.

This layer is an interoperability boundary, not a promise that every Markdown
dialect round-trips losslessly. The importer intentionally supports a bounded,
documented subset and stops with stable diagnostics on ambiguous constructs.
Outputs and loss reports never overwrite existing files. HTML contains inline
CSS, no scripts, and no remote resources; assets become explicit placeholders
in this first slice. `notmarkdown git install` changes only a selected local
repository and is idempotent. Public binaries and cross-platform distribution
remain delivery work, not format semantics.

## 4. Terminal editor

The terminal editor should be a single Rust binary for Linux, macOS, and
Windows terminals including PowerShell hosts. Its three modes are:

- **Document:** semantic text rendering, folding, list handling, links, asset
  placeholders, and keyboard-first structural commands;
- **Source:** syntax highlighting, diagnostics, completion, and exact text;
- **Package:** tree/table inspection of metadata, entries, representations,
  hashes, compression, captions, transcripts, posters, and attachments.

Images may be shown only through an optional detected terminal-image protocol.
The reliable baseline is alt text plus asset metadata. Audio/video launching is
an explicit external action; the terminal never claims embedded playback as a
portable baseline.

## 5. IDE integrations

VS Code and JetBrains integrations are thin host adapters over
`notmarkdown-lsp`, `notmarkdown`, and the same canonical model. Neither plugin
owns a private parser.

The VS Code 0.1 plugin contributes `.nmt` highlighting, an LSP client, semantic
CDM preview, a read-only `.nmdoc` Custom Editor, and explicit inspect/verify
commands. It does not start local tools in an untrusted workspace.

The JetBrains 0.1 scaffold uses the official IntelliJ LSP server support point
for commercial IDEs and background package actions. Because that LSP API is not
available in open-source IntelliJ builds or Android Studio, adoption requires a
second native baseline module for those hosts. This limitation is explicit;
the project does not claim one binary covers every JetBrains product.

The detailed rollout, host API references, copy hierarchy, and landing-page
information architecture live in `NotMarkdown-Adoption-Plan-0.1.md`.

## 6. Desktop editor

The desktop application should reuse the browser UI inside Tauri while moving
filesystem, large-package streaming, codec, hash, and validation work into the
shared Rust core. This produces native installers for Windows, macOS, and Linux
without creating a second UI implementation immediately.

Desktop-specific capabilities stay narrow:

- native open/save dialogs and recent documents;
- atomic saves and recovery snapshots;
- large-file streaming and background preview generation;
- OS media integration and accessibility bridges;
- explicit external-link and attachment opening.

The desktop layer must not add arbitrary per-document styling or executable
content.

## 7. Delivery sequence

### Milestone A — browser vertical slice (implemented)

- three synchronized views;
- local `.nmt` and `.nmdoc` open/save;
- embedded assets and media previews;
- Deflate/Zstandard profiles;
- installable static browser build;
- unit, UI-navigation, determinism, integrity, and interoperability tests.
- automatic outline and local full-text search inside the Document view;
- verified package-wide search over captions, transcripts, and textual
  attachments with direct navigation to their referencing document block;
- visible `!toc` rendering derived from current headings rather than stored
  navigation text.

### Milestone B — harden the browser editor

- range-based large-package opening with deferred verified assets
  (implemented in Studio 0.5);
- deterministic streaming writes to atomic native browser sinks
  (implemented in Studio 0.6);
- portable landing-page embed mode and compact responsive editor shell
  (implemented in Studio 0.6.1);
- installed-PWA `.nmdoc`/`.nmt` file launches and a local one-shot Web Share
  Target with capability-labelled fallbacks (implemented in Studio 0.6.2);
- complete visual controls for the 0.1 parser surface;
- IndexedDB recovery and explicit unsaved-state handling;
- multi-representation asset editing and persisted generated caches;
- accessibility and cross-browser test matrix;
- signed release artifacts and hosted demo.

### Milestone C — shared Rust core and terminal editor (vertical slice implemented)

- Rust canonical model, strict parser slice, diagnostics, and semantic terminal
  rendering;
- metadata-first package reader for store, Deflate, and Zstandard entries;
- deferred representation verification during search, extraction, unpacking,
  explicit `verify`, and repacking;
- deterministic repacking that verifies embedded representations while
  streaming them into the new package;
- terminal document/source/package modes with live last-valid-tree behavior;
- nested/task lists, footnotes, internal-reference validation, diagrams, charts,
  math blocks, and attachments in the Rust semantic model;
- safe extraction of selected logical assets from the terminal package view;
- structured inline semantics and typed media fallback attributes in the Rust
  core rather than flattened display strings;
- canonical CDM JSON serialization with schema field order, omitted defaults,
  sorted definition maps, and cross-implementation tree equality fixtures;
- staged asset add, replace, and remove operations in the terminal Package view,
  committed transactionally with source changes;
- deterministic mutation repacks whose final manifest asset IDs exactly match
  the source references;
- standalone Rust `parse`, `pack`, `unpack`, `inspect`, `verify`, and semantic
  `diff` commands, including deterministic creation from loose assets and
  atomic no-overwrite extraction;
- deterministic outline and disposable search-index APIs with CDM paths;
- bounded UTF-8 asset indexing with WebVTT cleanup, explicit omissions, and no
  binary-media decoding;
- incremental session-cache reuse, per-asset invalidation, stale-entry pruning,
  and visible reuse/rebuild telemetry in browser and terminal search;
- Rust and TypeScript `outline`, `index`, and `search` CLI parity;
- terminal outline/search overlays with direct document navigation, preserving
  the original three-view model;
- two-way package interoperability tests with the TypeScript implementation.
- language-neutral conformance schemas, runner contract, fixtures, eight active
  cases, and three clearly separated draft security cases;
- bounded Markdown import, Markdown/inert-HTML export, versioned loss reports,
  and repository-local semantic Git text conversion.

Remaining before Milestone C is complete:

- remaining attribute and diagnostic-code edge-case parity;
- multi-representation asset authoring in the Package view;
- automated Linux, macOS, and Windows release builds.

### Milestone D — IDE integrations and adoption (initial slice implemented)

- shared Rust `notmarkdown-lsp` diagnostics, symbols, hover, and completion;
- compiled VS Code 0.1 source/package extension scaffold;
- JetBrains 0.1 commercial-LSP scaffold and documented Community split;
- polished responsive landing page with the real Studio embedded directly,
  browser-rendered desktop/mobile QA, and automated accessibility QA;
- MIME, Linux desktop-entry, icon, and media-type registration-draft scaffolds
  that remain inert until installed by a platform package;
- remaining: signed bundled binaries, VSIX/Marketplace packages, JetBrains
  verifier matrix, hosted Studio, native JetBrains baseline module, verified
  Compatibility Kit commands, and Windows/macOS association packages.

### Milestone E — desktop application

- Tauri shell using the same three-view web UI;
- native filesystem and recovery integration;
- platform installers, update signing, and accessibility QA.

## 8. Decisions held firm

- one ordinary `.nmdoc` file is the normal sharing unit;
- `document.nmt` remains human-readable and authoritative;
- formatting stays semantic and constrained by versioned themes;
- media is embedded, inert by default, and accessible through fallbacks;
- format semantics are independent of UI framework and operating system;
- invalid or unsupported content is diagnosed, never guessed or silently lost.
