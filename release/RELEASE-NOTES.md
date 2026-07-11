# NotMarkdown Compatibility Kit 0.2.0

Status: public prerelease candidate; format 0.1 remains a draft
Prepared: 2026-07-11

This candidate removes several practical barriers to trying NotMarkdown
without changing the static-document boundary. Project source lives at
`https://github.com/TheAnonymous/NotMarkdown` and the browser experience at
`https://theanonymous.github.io/NotMarkdown/`. Native archives are unsigned;
no Marketplace, package-manager repository, or app-store publication is
implied by this GitHub prerelease.

## What is included

- Rust toolchain 0.12.0 with offline, explicitly selected
  `commonmark`/`github`-dialect import into `.nmt` or `.nmdoc`, including
  atomic recursive tree migration with safe local assets;
- Markdown and inert standalone-HTML export with versioned JSON loss reports;
- opt-in, repository-local semantic Git diffs for `.nmt` and `.nmdoc`;
- Studio 0.7.0 with static Mermaid and Vega-Lite previews, draw.io intake,
  installed-PWA file handlers, operating-system launch intake, and universal
  picker/drop/save fallbacks;
- ten active language-neutral conformance cases and three isolated draft
  adversarial-package cases;
- cross-platform release automation for unsigned CLI/LSP/TUI archives on
  Linux, macOS, and Windows, each on x64 and arm64;
- an installable, payload-verified VS Code 0.2.0 VSIX;
- release-templated Homebrew, WinGet, Scoop, and AUR metadata generated from
  final artifact hashes;
- GitHub keyless build-provenance attestations for every final asset;
- proposed media types, Linux MIME/desktop-entry scaffolds, and source icon;
- deterministic local source archives, a machine-readable release manifest,
  and SHA-256 checksums.
- MIT-licensed implementation code, CC0 specification/conformance material,
  and an explicit third-party notice inventory.

## Migration commands

```sh
notmarkdown import README.md --dialect commonmark --to nmdoc \
  --output README.nmdoc --loss-report import-loss.json

notmarkdown export README.nmdoc --to markdown \
  --output README-export.md --loss-report markdown-loss.json

notmarkdown export README.nmdoc --to html \
  --output README.html --loss-report html-loss.json

notmarkdown git install --local .
```

Conversion never overwrites an existing output or loss report. Import never
fetches remote images, local image paths cannot escape the Markdown file's
directory, and an error creates no partial document. HTML output escapes text
and attributes, contains inline CSS but no script or remote resource, and adds
a restrictive Content Security Policy. SHA-verified, allowlisted images,
audio, and video are embedded as bounded data URLs; unsafe SVG, unsupported
media, and assets beyond the export budget become labeled placeholders with an
explicit loss entry.

## Deliberate 0.1 limits

The importer is a bounded, deterministic migration subset, not a claim of full
CommonMark or GitHub Flavored Markdown conformance. It accepts familiar direct
mappings such as ATX headings, paragraphs, flat lists, simple quotations,
fenced code, emphasis, strong text, one-backtick code spans, safe HTTPS links,
and local images. Ambiguous or unsupported structures stop with stable
diagnostics instead of being guessed or silently deleted.

The candidate does not include signed installers, marketplace uploads, a
hosted service, an approved IANA registration, a reusable WASM viewer, or the
static publisher planned for the remainder of the Compatibility Kit milestone.
The Tauri desktop wrapper is a deliberately unbundled scaffold, not a shipped
desktop application. Package-manager files are review inputs, not evidence of
publication in any central repository.
Documents remain inert: no scripts, macros, forms, presentation runtime, or
executable notebook cells are introduced.

## Verification evidence and release gates

- the release workflow blocks publication unless the full Rust workspace passes
  with locked dependencies on Rust 1.97, followed by a real CLI
  import/export/parse/deterministic-pack/verify smoke;
- Rust toolchain 0.12.0: 59 workspace tests, Clippy with warnings denied, and
  rustfmt check passed locally;
- real disposable-repository Git smoke tests produced canonical semantic text
  for a changed `.nmdoc` package, including Linux repository and executable
  paths containing spaces and non-ASCII characters;
- TypeScript reference toolchain 0.6.0: 33 tests passed;
- Studio 0.7.0: 39 tests, TypeScript build, production build, and production
  dependency audit passed;
- VS Code extension 0.2.0: two manifest/grammar/snippet tests passed; the real
  11-file, 123.02-KB VSIX passed payload verification with source, tests,
  dependencies, and its 1.3-MB source map excluded;
- release/distribution tooling: 13 offline tests passed, including repeated
  deterministic native/source archives, fail-closed tamper checks, real
  package-manager archive paths, Desktop manifest/lock consistency, workflow
  policy, and VSIX allow/deny payloads;
- landing page 0.3.0: live-Studio and visuals integration check passed;
- conformance metadata: all 13 cases and fixtures validated;
- MIME XML, icon XML, and read-only workflow policy checks passed.

The JetBrains project remains a source scaffold in this candidate because the
required Gradle/IDE verifier toolchain was not available in the preparation
environment. Marketplace upload and plugin signing remain separate manual
gates.

## Release controls

The committed release trigger derives a new RC tag from Compatibility Kit 0.2.0
and a monotonically increasing candidate number. Automation refuses to mutate
an existing tag or release. Every final asset is covered by `SHA256SUMS` and a
GitHub build-provenance attestation; verify downloads with
`gh attestation verify <asset> -R TheAnonymous/NotMarkdown`. Stable promotion,
platform signing, Marketplace upload, and package-manager submission remain
explicitly separate decisions.
