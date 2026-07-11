# NotMarkdown

[![Pages](https://github.com/TheAnonymous/NotMarkdown/actions/workflows/pages.yml/badge.svg)](https://github.com/TheAnonymous/NotMarkdown/actions/workflows/pages.yml)
[![Node toolchain](https://github.com/TheAnonymous/NotMarkdown/actions/workflows/node.yml/badge.svg)](https://github.com/TheAnonymous/NotMarkdown/actions/workflows/node.yml)
[![Rust workspace](https://github.com/TheAnonymous/NotMarkdown/actions/workflows/rust.yml/badge.svg)](https://github.com/TheAnonymous/NotMarkdown/actions/workflows/rust.yml)
[![Compatibility Kit](https://img.shields.io/github/v/release/TheAnonymous/NotMarkdown?include_prereleases&label=compatibility%20kit)](https://github.com/TheAnonymous/NotMarkdown/releases/tag/compatibility-kit-v0.2.0-rc.1)
[![License: MIT / CC0](https://img.shields.io/badge/license-MIT%20%2F%20CC0-5b4bc4)](LICENSE-POLICY.md)

NotMarkdown is a static, deterministic, single-file document format for
technical work. It keeps human-readable `document.nmt` source, embedded modern
media, metadata, fallbacks, and integrity information inside one portable
`.nmdoc` package.

The project deliberately does **not** define an executable notebook,
presentation runtime, web-application container, macro system, or free-form
desktop-publishing format. Documents are inert. Formatting remains semantic and
constrained.

## One document, three honest views

Every NotMarkdown editor exposes the same concepts:

1. **Document** — semantic reading and constrained visual editing.
2. **Source** — authoritative UTF-8 text close to Markdown.
3. **Package** — assets, representations, metadata, profiles, and verification.

## Document appearance and personal reading accessibility

NotMarkdown Studio keeps shareable design choices separate from personal
reading preferences. A document's choice among seven theme presets—Standard,
Paper, Technical, Minimal, Sepia, Midnight, or High Contrast—and its semantic
accent are stored in existing `@document` metadata and therefore travel with
`.nmt` source and `.nmdoc` packages.

The optional **Dyslexia-friendly** reading mode is local to the browser. It
changes only the Document view—using bundled OpenDyslexic fonts, a low-glare
background, generous text spacing, and a shorter line length—without changing
source, metadata, or package bytes. Studio remembers the preference locally
when storage is available. It is a user-selectable reading aid, not a medical
guarantee or a new document theme.

## Current implementation matrix

| Component | Version | State |
| --- | ---: | --- |
| Format draft | 0.1 | Normative draft with schemas and grammar |
| Rust core, package tools, CLI, LSP, TUI | 0.12.0 | Static visuals, import/export, and Compatibility Kit |
| Browser Studio | 0.7.0 | Local-first editor with Mermaid, Vega-Lite, and draw.io intake |
| Reference toolchain | 0.6.0 | Independent parser, package codec, search, and preflight |
| VS Code extension | 0.2.0 | Script-free preview, package inspector, and visual snippets |
| JetBrains extension | 0.1.0 | Commercial-LSP source scaffold |
| Landing page | 0.3.0 | Polished page with embedded real Studio and visual showcase |
| Compatibility Kit | 0.2.0 public RC | Visuals, import/export, Git, conformance, PWA, and attested release artifacts |

## Repository map

```text
notmarkdown-rust/              shared Rust core, package codec, CLI, LSP, TUI
notmarkdown-reference-parser/  independent TypeScript reference toolchain
notmarkdown-web-editor/        local-first browser Studio
notmarkdown-vscode/            VS Code extension
notmarkdown-jetbrains/         JetBrains extension
notmarkdown-site/              product landing page
conformance/                   language-neutral compatibility corpus
.github/workflows/             local CI definitions ready for publication
integrations/                  MIME and operating-system packaging scaffolds
release/                       deterministic offline source-release handoff
```

The format draft, CDM schema, source grammar, manifest schema, architecture,
and adoption plan live at the repository root so implementations can review
the contract without installing an editor.

## Try it in five minutes

The fastest path needs no installation: open the [live NotMarkdown
Studio](https://theanonymous.github.io/NotMarkdown/#studio), edit the example,
switch between Document, Source, and Package, then save an `.nmt` or `.nmdoc`
file locally. Documents are processed in the browser and are not uploaded.

To try the command-line implementation from source:

```sh
git clone https://github.com/TheAnonymous/NotMarkdown.git
cd NotMarkdown/notmarkdown-rust
cargo run --release -p notmarkdown-cli -- --help
```

Import a Markdown file together with safe local images, inspect the package,
and export readable Markdown again:

```sh
cargo run --release -p notmarkdown-cli -- import ../README.md \
  --dialect github --to nmdoc --output README.nmdoc \
  --loss-report import-loss.json
cargo run --release -p notmarkdown-cli -- inspect README.nmdoc
cargo run --release -p notmarkdown-cli -- export README.nmdoc \
  --to markdown --output README-export.md \
  --loss-report export-loss.json
```

Download the [single-file diagrams and charts
showcase](https://theanonymous.github.io/NotMarkdown/downloads/NotMarkdown-visuals-0.1.nmdoc)
to test Mermaid, Vega-Lite, and draw.io interoperability.

Unsigned CLI/LSP/TUI archives for Linux, macOS, and Windows on x64 and arm64,
the installable VS Code extension, checksums, and package-manager review files
are available in the [Compatibility Kit 0.2.0-rc.1
prerelease](https://github.com/TheAnonymous/NotMarkdown/releases/tag/compatibility-kit-v0.2.0-rc.1).

## Build and verify

Rust workspace:

```sh
cd notmarkdown-rust
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

TypeScript reference toolchain:

```sh
cd notmarkdown-reference-parser
npm ci
npm run check
```

Browser Studio:

```sh
cd notmarkdown-web-editor
npm ci
npm run check
```

Conformance metadata and a reproducible local source release:

```sh
node conformance/scripts/validate.mjs
python3 -B -m unittest discover -s release/tests -v
sh release/scripts/package-source.sh --output-dir release/out/local-candidate
sh release/scripts/verify-release.sh release/out/local-candidate
```

## Compatibility rule

Reading must require no commitment, writing should require at most one
installation, and leaving the format must remain possible. Importers never
silently guess a dialect. Exporters report every feature they cannot represent
faithfully. Unknown or unsupported content is diagnosed and preserved where
the version contract permits it; it is never silently deleted.

## Project status

The source repository and browser Studio are public; the format remains a 0.1
draft and is not yet 1.0. Compatibility Kit 0.2 provides bounded import/export,
semantic Git integration, active conformance fixtures, PWA file intake, and a
six-target unsigned prerelease pipeline with checksums and provenance
attestations. Code is MIT-licensed; specifications and conformance material use
CC0-1.0. Remaining work includes signed desktop installers, Marketplace and
package-repository review, a reusable WASM viewer, a complete third-party
audit, and maintainer-owned security/publishing controls.

See [ROADMAP.md](ROADMAP.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md).
