# NotMarkdown Compatibility Kit 0.2.0

Status: local release candidate and source handoff  
Prepared: 2026-07-11

This candidate removes several practical barriers to trying NotMarkdown
without changing the static-document boundary. It has not been published,
tagged, signed, or uploaded to a package registry. The format remains a 0.1
draft.

## What is included

- Rust toolchain 0.12.0 with offline, explicitly selected
  `commonmark`/`github`-dialect import into `.nmt` or `.nmdoc`;
- Markdown and inert standalone-HTML export with versioned JSON loss reports;
- opt-in, repository-local semantic Git diffs for `.nmt` and `.nmdoc`;
- Studio 0.7.0 with static Mermaid and Vega-Lite previews, draw.io intake,
  installed-PWA file handlers, operating-system launch intake, and universal
  picker/drop/save fallbacks;
- ten active language-neutral conformance cases and three isolated draft
  adversarial-package cases;
- read-only Linux/macOS/Windows CI workflow templates;
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
a restrictive Content Security Policy. Media becomes a labeled placeholder in
this first HTML slice and is recorded as an explicit loss.

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
Documents remain inert: no scripts, macros, forms, presentation runtime, or
executable notebook cells are introduced.

## Local verification evidence

- Rust 0.12 contains 52 workspace tests, but this reconstructed environment no
  longer contains cargo/rustfmt, so formatting, tests, and Clippy must be
  rerun in CI before a release tag;
- real disposable-repository Git smoke tests produced canonical semantic text
  for a changed `.nmdoc` package, including Linux repository and executable
  paths containing spaces and non-ASCII characters;
- TypeScript reference toolchain 0.6.0: 33 tests passed;
- Studio 0.7.0: 28 tests, TypeScript build, production build, and production
  dependency audit passed;
- VS Code extension 0.2.0: two manifest/grammar/snippet tests passed;
- landing page 0.3.0: live-Studio and visuals integration check passed;
- conformance metadata: all 13 cases and fixtures validated;
- MIME XML, icon XML, and read-only workflow policy checks passed.

The JetBrains project remains a source scaffold in this handoff because the
required Gradle/IDE verifier toolchain was not available in the preparation
environment. The prepared CI definitions have not run on a public host yet.

## Publication stop gates

The license decision is now recorded: MIT for code and CC0-1.0 for the format,
schemas, grammar, conformance material, project documentation, and examples.
Publication still needs contributor/asset rights confirmation, a complete
redistribution notice audit, and a real monitored private security contact.
