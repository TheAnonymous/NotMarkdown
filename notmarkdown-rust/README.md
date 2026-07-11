# NotMarkdown Rust workspace 0.12

This workspace is the first shared-core and terminal-editor vertical slice for
NotMarkdown. It opens real `.nmt` source and modern or portable `.nmdoc`
packages without calling the TypeScript implementation at runtime.

## Workspace

```text
crates/notmarkdown-core       canonical types, parser slice, diagnostics, text rendering
crates/notmarkdown-cli        core commands plus the first local Compatibility Kit
crates/notmarkdown-lsp        editor-neutral diagnostics, outline, hover, and completion
crates/notmarkdown-package    bounded package reader, integrity checks, deterministic repacks
crates/notmarkdown-tui        full-screen terminal editor with three synchronized views
```

The core crates have no dependency on Ratatui or Crossterm. Format semantics
therefore stay independent of the terminal UI and can later be reused by the
desktop application and WebAssembly bindings.

## Build and verify

Rust 1.97 or newer is required.

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release -p notmarkdown-cli -p notmarkdown-tui -p notmarkdown-lsp
```

The binaries are `target/release/notmarkdown`, `target/release/notmd-tui`, and
`target/release/notmarkdown-lsp` on Linux/macOS, with `.exe` suffixes on
Windows.

## Run

Open a packaged document:

```sh
cargo run -p notmarkdown-tui -- ../NotMarkdown-example-modern-0.1.nmdoc
```

Open source or start a new document:

```sh
cargo run -p notmarkdown-tui -- document.nmt
cargo run -p notmarkdown-tui
```

## Command-line toolchain

Emit normative CDM JSON, derive navigation data, create a package, inspect it,
and unpack it:

```sh
notmarkdown parse document.nmt
notmarkdown outline document.nmt
notmarkdown index document.nmdoc
notmarkdown search document.nmdoc "spoken captions"
notmarkdown pack document.nmt --output document.nmdoc \
  --profile modern --asset photo=photo.avif
notmarkdown inspect document.nmdoc
notmarkdown verify document.nmdoc
notmarkdown unpack document.nmdoc --output unpacked
```

`inspect` verifies package structure and source without reading large asset
payloads; its JSON labels representation verification as deferred. `verify`
streams every representation through CRC-32 and SHA-256 and reports the count
only after the complete package succeeds.

`pack` accepts `modern` Zstandard and `portable` Deflate profiles. It derives
media type, logical kind, role, byte length, and SHA-256 from every mapped file.
Source references and supplied asset IDs must match exactly. Package files and
unpack targets are never overwritten.

Compare source or packaged documents semantically:

```sh
notmarkdown diff old.nmdoc new.nmdoc
notmarkdown diff document.nmt document.nmdoc
```

`diff` compares canonical CDM trees rather than source spelling. When both
inputs are packages it additionally compares logical assets by kind, role,
media type, byte length, and SHA-256. Its JSON report uses JSON Pointer paths;
exit status `0` means equal and `1` means different. `outline` emits the
heading structure with stable CDM paths. For `.nmdoc`, `index` also reads
verified UTF-8 captions, transcripts, and textual attachments; `search` returns
ranked contextual hits that identify the originating asset and jump to its
referencing block. Binary media is never decoded for search. `--compact` is
available for every JSON-producing command.

### Compatibility Kit 0.1

The first migration slice works entirely offline and does not require GitHub:

```sh
notmarkdown import README.md --dialect commonmark --to nmdoc \
  --output README.nmdoc --loss-report import-loss.json
notmarkdown export README.nmdoc --to markdown \
  --output README-export.md --loss-report markdown-loss.json
notmarkdown export README.nmdoc --to html \
  --output README.html --loss-report html-loss.json
notmarkdown git install --local .
```

`import` is deliberately **not a complete CommonMark or GitHub-Flavored
Markdown implementation**. The dialect flag records which compatibility
boundary the caller requested; version 0.1 accepts a deterministic,
metadata-free subset:

- ATX headings, paragraphs, simple quotations, thematic breaks, fenced code;
- flat ordered and unordered lists;
- emphasis, strong importance, one-backtick code spans, safe HTTPS links;
- local relative images. For `.nmdoc` output their bytes are embedded; the
  default `portable` profile maximizes receiver compatibility.
- exact lowercase `mermaid`, `vega-lite`, and `vegalite` fenced source. These
  remain inert code blocks and round-trip without executing anything;
- standalone Markdown images ending in `.drawio.svg`, which are embedded as
  native static diagrams. Plain local `.drawio`/`.dio` links retain their
  label and editable source as embedded asset links.

The reader is bounded to 8 MiB, 100,000 lines, 100,000 blocks, 16 levels of
inline nesting, and 512 images. It never fetches remote images and never follows
a local image path outside the Markdown file's directory. Ambiguous or
unsupported constructs—including YAML front matter, Setext headings, nested
lists, tables, task lists, reference links, raw HTML, autolinks,
strikethrough, multi-backtick spans, and CommonMark's undefined generated
heading IDs—are reported with stable `NMD-I…` codes. Errors create no document;
safe degradations are recorded as warnings. Without `--loss-report` the same
items are printed to standard error, so conversion loss is never silent.
Reports retain at most 4,096 detailed items while keeping complete error and
warning counts plus an explicit `truncated` flag.

Markdown export retains familiar syntax and records every non-portable
NotMarkdown feature in a versioned JSON loss report. HTML export creates one
inert, responsive file: CSS is inline, text and attributes are escaped, there
are no scripts or remote resources, and embedded assets become labeled static
placeholders with `NMD-E100` entries. Mermaid and Vega-Lite fences become
escaped source fallbacks with explicit `NMD-E104`/`NMD-E105` entries. This
initial safe export intentionally
does not put potentially very large media into data URLs.

All conversion outputs and loss reports use create-new semantics: existing
files are never overwritten. `notmarkdown git install` only edits the selected
local repository. It appends an idempotent `.gitattributes` block and configures
a cached `textconv` that emits canonical CDM plus stable asset metadata for
semantic diffs. `notmarkdown git source file.nmdoc` separately exposes the
human-readable packaged `document.nmt`. No remote or GitHub operation occurs.

The terminal editor keeps a bounded session cache of normalized embedded text.
Verified SHA-256 fingerprints allow repeated searches to reuse unchanged
representations without reopening their ZIP entries. Its status line reports
how many assets were reused or rebuilt; source edits rebuild document paths but
retain unchanged asset text.

## Language server

`notmarkdown-lsp` exposes the Rust parser to editor-neutral Language Server
Protocol clients over standard input/output:

- full-document synchronization and structured diagnostics;
- heading symbols for outline, breadcrumbs, and navigation;
- context-sensitive hover for headers, directives, and asset references;
- snippets for metadata, contents, callouts, diagrams, charts, and attachments.

The server never opens network resources or executes document content. VS Code
and JetBrains plugins launch this same binary, so host integrations cannot
silently drift into different source dialects.

```sh
cargo run -p notmarkdown-lsp -- --stdio
```

### Keys

| Key | Action |
| --- | --- |
| `F1` | Document view |
| `F2` | Editable `document.nmt` source |
| `F3` | Package metadata, assets, representations, and entries |
| `Tab` / `Shift+Tab` | Cycle views |
| arrows, Home/End, Page Up/Down | Edit or scroll |
| `Ctrl+S` | Save valid source |
| `Ctrl+Q` | Quit; a second press confirms discarding unsaved changes |
| `Ctrl+O` | Open the automatically derived outline |
| `/` or `Ctrl+F` | Search document and embedded textual assets locally |
| `j` / `k` in Package | Select a logical asset |
| `x` in Package | Extract every representation of the selected asset |
| `a` in Package | Stage a new asset as `<asset-id> <file-path>` |
| `d` in Package | Stage removal, undo removal, or unstage a new asset |

Loose `.nmt` files save in place. An opened `.nmdoc` is never overwritten:
`Ctrl+S` creates `name.edited.nmdoc`, then numbered siblings for further saves.
Unchanged asset representations are verified while they stream from the
original package into the new package. Additions and removals are staged in the Package
view and committed together with valid source on `Ctrl+S`. The source asset
references and final manifest asset IDs must match exactly, so a half-applied
asset edit cannot be saved.

## Implemented core slice

- mandatory 0.1 header and typed metadata scalars;
- headings and explicit heading IDs;
- paragraphs with familiar inline text reduced to terminal-safe text;
- automatically numbered ordered lists and unordered lists;
- nested lists and static checked/unchecked task items;
- quotations, fenced code, thematic breaks, and short callouts;
- exact, case-sensitive Mermaid and Vega-Lite static-visual fences with a
  256 KiB/10,000-line preflight, offline Mermaid policy, and a values-only,
  positive-allowlist Vega-Lite subset;
- embedded image, audio, and video references;
- footnote definitions/references and unresolved internal-reference checks;
- diagram, chart, math-block, and attachment nodes;
- structured inline nodes for text, emphasis, strong importance, code, links,
  cross-references, footnotes, hard breaks, inline math, and inline images;
- typed image layout/decorative state and audio/video layout, poster,
  transcript, chapters, start time, and language-keyed captions;
- normative, schema-ordered CDM JSON with omitted defaults and sorted map keys;
- automatic heading outline, disposable full-text index, ranked contextual
  package search, and optional visible `!toc` placement;
- bounded indexing of verified UTF-8 captions, transcripts, chapters, diagram
  sources, data, and textual attachments with WebVTT cue cleanup;
- incremental source/asset cache invalidation with SHA-256 keys, active-entry
  pruning, and reuse/rebuild statistics;
- stable asset-ID collection and semantic terminal rendering;
- structured line/column diagnostics;
- last-valid-document behavior while source contains errors.

Unsupported 0.1 directives fail visibly. They are not guessed or silently
dropped.

## Package behavior

The reader supports ZIP methods 0, 8, and 93 for the NotMarkdown store,
Deflate, and Zstandard profiles. Its metadata-first open checks:

- package entry count, individual size, total expanded size, and compression
  ratio limits;
- normalized relative paths and duplicate entries;
- first uncompressed `mimetype` entry;
- manifest version/profile fields;
- UTF-8 source and source SHA-256;
- every asset representation's declared byte length against ZIP metadata;
- declared-versus-present entries;
- source asset references versus manifest asset IDs;
- parser validity.

Representation payloads remain deferred at open. Search reads only bounded
recognized text assets. Extraction, unpacking, repacking, and `verify` stream
only the requested payloads; before any output is committed they require the
expanded length, ZIP CRC-32, and manifest SHA-256 to agree. This keeps terminal
and future desktop startup independent of embedded video size without weakening
the point at which asset bytes become usable.

The repacker uses fixed timestamps, canonical member order, fixed compression
levels, canonical JSON, and the required UTF-8 ZIP flag. It can transactionally
retain, remove, replace, and add logical assets while deriving media metadata
and hashes from new files. Tests verify that two equivalent Rust mutations are
byte-identical.

The package writer also creates deterministic modern or portable packages from
loose source and asset files. Full unpacking is staged in a sibling directory
and renamed only after every verified entry is written. The reader enforces the
declared compression profile in addition to hashes and resource limits.

## Media in terminals

The portable baseline is descriptive rather than graphical: media kind, label,
asset ID, representation roles, media types, byte sizes, posters, captions,
and transcripts remain inspectable. Audio and video never autoplay. A future
optional adapter may detect terminal image protocols, but document correctness
never depends on them.

## Cross-implementation tests

The package tests open the modern Zstandard fixture produced by the TypeScript
reference toolchain. Rust-created packages, repacks, and asset replacements are
then opened by that Node reader. Shared basic and comprehensive fixtures must
produce semantically identical CDM trees in Rust and TypeScript. This catches
model and container drift in both directions.

## Deliberate limits of this milestone

- Parsing now covers the principal block and inline node families with canonical
  CDM JSON. Remaining attribute edge cases and complete diagnostic-code parity
  still need conformance work.
- The terminal package view can inspect, add, replace, remove, repack, and
  extract logical assets. Authoring multiple representations for one asset
  remains a later package-view increment.
- Windows and macOS builds are designed through Crossterm but have not yet run
  in this Linux build environment.
- Multi-representation authoring, ZIP64, signatures, and recovery journals
  remain later work.

The format still excludes scripts, macros, notebook cells, interactive forms,
arbitrary HTML, and unconstrained visual layout.

## Static visuals and safety

The core recognizes only `mermaid`, `vega-lite`, and the `vegalite` alias.
`Mermaid`, `VEGA-LITE`, and `vl` remain ordinary code languages. Parser,
indexer, terminal renderer, importer, and exporter all preserve the source;
rendering is an optional adapter concern and is never part of parsing.

Mermaid preflight refuses configuration/front matter, directives,
interactions, active markup, links, and local or remote resources. Vega-Lite
accepts only inline `data.values`, safe string marks and field definitions,
bounded dimensions, and a small recursively allowlisted encoding surface. It
rejects transforms, expressions, format strings, remote data, layering,
faceting, concatenation, and unknown keys. Native chart types must agree with
their mark (`bar`, `line`, `area`, `point|circle`, or `arc`).

The package layer recognizes `.mmd`/`.mermaid`, `.drawio`/`.dio`, editable
`.drawio.svg`, and `.vl.json`/`.vegalite.json` compound suffixes. It also
accepts canonical, v5, and v6 Vega-Lite media-type aliases while writing the
canonical media type.
