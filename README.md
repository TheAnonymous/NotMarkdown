# NotMarkdown

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
| Compatibility Kit | 0.2.0 local RC | Visuals, import/export, Git, conformance, PWA, and release handoff |

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

This repository is being prepared for its first public source publication. The
format is not yet 1.0. The local Compatibility Kit now provides bounded,
explicit import/export, semantic Git integration, active conformance fixtures,
and installable-PWA file intake. Code is MIT-licensed; specifications and
conformance material use CC0-1.0. Remaining release work includes cross-platform
binary builds, a reusable viewer/static publisher, signing, distribution, a
complete third-party audit, and a monitored private security contact.

See [ROADMAP.md](ROADMAP.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md).
