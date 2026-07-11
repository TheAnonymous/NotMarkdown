# NotMarkdown roadmap

## Compatibility Kit 0.2 — public release candidate

The goal is to make `receive, open, convert, publish, diff, and verify` as
frictionless as authoring already is.

Implemented and locally verified:

- bounded CommonMark/GitHub-dialect import with explicit dialect choice,
  recursive tree migration, and adoption of safe local assets;
- Markdown export and inert self-contained HTML export with verified embedded
  image/audio/video assets and explicit loss reports;
- machine-readable loss reports for non-representable semantics;
- `notmarkdown git install` and cached canonical text conversion;
- a language-neutral conformance corpus and read-only cross-platform CI;
- installed-PWA file handling with universal picker/drop fallbacks;
- deterministic source archives and checksums;
- six-target CLI/LSP/TUI release automation, a payload-verified VSIX,
  provenance attestations, and generated Homebrew/WinGet/Scoop/AUR inputs;
- editable Mermaid/Vega-Lite source and multi-representation draw.io assets in
  the browser Studio.

Still required before the Compatibility Kit becomes stable:

- successful public CI and native release smoke tests on all six targets;
- signed desktop installers and platform lifecycle testing;
- Marketplace and package-repository review under maintainer-owned accounts;
- a reusable read-only WASM viewer and richer static diagram rendering.

## Everywhere 0.3

- signed Windows, macOS, and Linux desktop installers;
- `.nmdoc` and `.nmt` operating-system file associations;
- bundled platform binaries in VS Code and JetBrains extensions;
- VS Code Marketplace, Open VSX, and JetBrains Marketplace releases;
- a WASM VS Code web extension for `vscode.dev` and `github.dev`;
- GitHub/GitLab verify, semantic-diff, and preview integrations;
- Homebrew, WinGet/Scoop, and a Linux package channel.

## Interoperability 0.4

- stable Rust/WASM/C API surface and thin language bindings;
- normative media- and theme-profile selection algorithms;
- MIME registration and operating-system MIME databases;
- Quick Look, Explorer preview/thumbnail, and Linux thumbnail integration;
- accessibility validation profile;
- parser/container fuzzing and an adversarial public corpus;
- two independent conforming implementations before 1.0.

## Held boundaries

NotMarkdown will not become an executable notebook, presentation runtime,
macro host, interactive-document platform, or arbitrary HTML container.
Tooling plugins may import, export, lint, or author static semantics. Opening a
document never downloads or executes extension code.
