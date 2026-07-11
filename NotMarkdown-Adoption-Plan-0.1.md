# NotMarkdown Adoption and Landing Page Plan 0.1

Status: implemented polished landing, local-first PWA intake, and adoption scaffolds  
Date: 2026-07-11

## 1. Adoption thesis

NotMarkdown should not be introduced as another office suite or a richer
Markdown dialect. Its memorable promise is:

> Markdown's simplicity. Without the loose ends.

The concrete proof is a single `.nmdoc` file with a human-readable
`document.nmt` authority, embedded modern media, deterministic semantics, and
the same three honest views everywhere:

1. Document — read and edit within constrained semantic formatting.
2. Source — inspect ordinary text close to Markdown.
3. Package — inspect assets, representations, metadata, and verification state.

The first visit must reach a working local editor in one click. No account,
upload, cloud import, or tutorial gate should stand between the claim and the
proof.

## 2. Primary audiences

### Technical writers and maintainers

They want Markdown-like diffs and repository workflows without broken image
folders, dialect drift, manual numbering, or external diagram tooling.

### Engineers documenting systems

They want source control, CLI automation, IDE diagnostics, diagrams, data,
math, citations, and inspectable packages without an executable notebook.

### Teams exchanging durable documents

They want one inert file that opens offline, remains auditable, and cannot hide
scripts, remote dependencies, or arbitrary layout tricks.

## 3. Landing-page information architecture

The working 0.2 implementation is in `notmarkdown-site/`. It embeds the real
Studio 0.6.2 production build rather than imitating the editor.

### Hero

- Eyebrow: `Format draft 0.1 · Studio 0.6.2`
- Headline: `Markdown's simplicity. Without the loose ends.`
- Support: one portable file; readable source; embedded images, audio, video,
  diagrams, data, captions, and attachments; no execution.
- Primary CTA: `Start writing`, scrolling directly to the embedded editor.
- Secondary CTA: `See how it works`, continuing to the three-view explanation.
- Immediate trust line: `No account · no upload · no runtime in documents`

### Live Studio

The first proof after the Hero is a full real Studio session with an editable
built-in document. Users can edit, switch among Document, Source, and Package,
open local `.nmt`/`.nmdoc` files, and save a package without leaving the page.
The same frame provides a clear top-level `Open full size` route because native
save-file picker availability is best in a top-level browsing context.

After Studio is installed as a PWA on a supporting browser/operating-system
pair, its manifest can associate `.nmt` and `.nmdoc` with the application. A
system file launch enters the same extension-checked intake path as picker and
drag/drop. A local Web Share Target can receive one supported file through the
service worker, retain it briefly in origin-private storage, and delete it when
Studio consumes it. There is no upload endpoint. These integrations are
progressive enhancements: the visible Open button, drag/drop, native-save
picker, and download fallback remain the portable baseline.

The Studio build uses relative production asset, manifest, and service-worker
paths so it remains functional below a hosted subdirectory. `?embed=1` adapts
the real application shell for compact frames; it does not create a reduced
demonstration implementation.

### Proof strip

Show the same small document as Source, Document, and Package. This explains
the product faster than a long feature grid and establishes that none of the
views is a hidden proprietary representation.

### Problem-to-outcome section

Use four concrete contrasts:

- asset folders → one `.nmdoc`;
- Markdown dialects → one versioned grammar;
- manual contents and list repair → derived navigation and numbering;
- arbitrary styling → semantic themes that remain difficult to make ugly.

Do not lead with compression methods or AST terminology. Those are credibility
details after the product has become understandable.

### Workflow section

Show the adoption ladder rather than asking users to change everything:

1. Import one existing Markdown file with an explicit dialect and loss report.
2. Open or author the result locally in the browser.
3. Keep package changes reviewable with repository-local Git text conversion
   and add the IDE plugin when useful.
4. Add `notmarkdown verify` to CI and adopt `.nmdoc` as the sharing artifact.

The same ladder now also accepts existing content through the locally verified
Rust 0.11 Compatibility Kit: a deliberately bounded CommonMark/GitHub-dialect
importer, constrained Markdown/static HTML export, and Git-readable package
diffs. Import and export produce explicit human- and machine-readable loss
reports when the target cannot preserve a NotMarkdown concept. Git
configuration is opt-in and repository-local; opening a document never
silently rewrites Git settings. Public binaries and distribution remain a
release task, but the commands themselves run without GitHub.

### Tooling section

Present Browser Studio, CLI/TUI, VS Code, and JetBrains as four surfaces over
one parser and package contract. The IDE cards should link to installation and
show the shared language-server features: diagnostics, outline, hover,
completion, preview, inspect, and verify.

### Format and trust section

Use inspectable facts:

- deterministic constrained ZIP container;
- `portable-0.1` Deflate and `modern-0.1` Zstandard profiles;
- CRC-32 plus manifest SHA-256;
- progressive verification with visible deferred state;
- static content only; no scripts, macros, forms, notebooks, or remote assets.

The download area should also link to the proposed MIME declarations and
platform-integration status. The repository currently includes deterministic
`.nmdoc` identification, a Linux shared-mime-info definition and desktop-entry
template, source icon artwork, and an IANA registration draft. Label all of
these accurately: they are packaging scaffolds, not installed associations or
approved registrations. Windows ProgID/MSIX and macOS UTType/Quick Look support
follow once stable bundle identifiers and signing identities exist.

### Final CTA

Repeat one low-risk action: `Open Studio — your files stay on this device.`

## 4. Visual direction

The visual system should feel technical, calm, and finished rather than
futuristic for its own sake.

- warm off-white canvas with near-black ink;
- violet accent used for state and navigation, not decoration everywhere;
- mono labels for source, hashes, paths, and versioned profiles;
- large editorial headline paired with compact interface specimens;
- restrained rounding and shadows;
- no stock photography, fake 3D documents, gradient blobs, or animated noise;
- light/dark adaptation later, but one excellent light composition first.

The page itself follows the format philosophy: limited design tokens prevent
accidental visual incoherence.

The implemented 0.2 composition has been rendered at 1440 × 1000 and 390 × 844
browser viewports. Both the page and embedded Studio avoid horizontal overflow,
and the combined page/editor surface passes automated accessibility analysis
without reported violations. Keyboard skip navigation, focus visibility, and
reduced-motion adaptation are explicit requirements.

## 5. Conformance as an adoption surface

Adoption requires more than a reference implementation. The implemented
`conformance/` scaffold gives independent parsers and tools a neutral contract:
JSON Schema 2020-12 case formats, a JSON Lines adapter protocol, a lightweight
offline validator, fixtures, and an ordered suite.

Eight active cases exercise source parsing, bounded CommonMark import, invalid
UTF-8 rejection, and deterministic package behavior. Three draft cases cover
adversarial ZIP mutations. Drafts are skipped by default and do not define
diagnostics before a neutral mutation harness exists. Adapters declare
capabilities, so a partial implementation reports a visible skip instead of a
false pass.

Read-only Node and Rust workflow templates are prepared for Linux, macOS, and
Windows. They use no publication credentials and gain value as soon as the
repository is hosted, but the suite and its validator run locally without
GitHub or network access today.

## 6. IDE architecture

```text
                       notmarkdown-core
                              |
                      notmarkdown-lsp --stdio
                       /                 \
            VS Code language client     JetBrains LSP module
                     |                         |
        source + preview + package      source + package actions
                     \                         /
                      notmarkdown CLI/package
```

`notmarkdown-lsp` is the semantic authority for diagnostics, completion, hover,
and document symbols. Extensions own host-specific lifecycle, trust, menus,
previews, and package UI. They do not reimplement the source grammar.

### VS Code 0.1

Implemented in `notmarkdown-vscode/`:

- `.nmt` TextMate grammar and language configuration;
- LSP client using a local `notmarkdown-lsp` process;
- semantic CDM preview for source;
- read-only `.nmdoc` custom Package editor;
- `inspect` and complete `verify` commands;
- limited untrusted-workspace mode that never starts local binaries.

VS Code's official Custom Editor API supports a custom model for binary
resources, which is the correct long-term host for the full `.nmdoc` three-view
experience. The 0.1 plugin intentionally starts read-only while save, undo,
backup, and hot-exit semantics are designed against the streaming writer.

### JetBrains 0.1

Implemented as a source scaffold in `notmarkdown-jetbrains/`:

- `.nmt` and `.nmdoc` file types;
- shared Rust LSP process;
- background package inspection and verification actions;
- environment-configurable binary locations.

The official JetBrains LSP API is an extension of commercial IntelliJ-based
IDEs and is not available in open-source IntelliJ builds or Android Studio.
The adoption plan therefore has two modules:

1. `notmarkdown-jetbrains-lsp` for supported commercial IDEs and unified
   PyCharm environments;
2. `notmarkdown-jetbrains-core` using native IntelliJ language APIs for file
   type, highlighting, package inspection, CLI actions, and eventually a small
   protocol adapter for Community/Android Studio.

This avoids pretending that one LSP-dependent binary covers the whole
JetBrains ecosystem.

## 7. Release sequence

### Adoption slice A — implemented

- deterministic browser streaming writer with native atomic save where the
  File System Access API is available;
- compatibility download elsewhere;
- shared Rust language server;
- tested VS Code plugin scaffold;
- JetBrains commercial-LSP scaffold;
- polished responsive landing page with the real Studio embedded directly;
- portable subdirectory hosting for Studio assets and offline entry points;
- installed-PWA `.nmt`/`.nmdoc` launch handling, a local one-shot Web Share
  Target, and explicit picker/drag/drop/save/download fallbacks;
- language-neutral conformance schemas, runner contract, initial active/draft
  suite, and read-only cross-platform CI workflow templates;
- bounded CommonMark/GitHub-dialect import, Markdown/inert-HTML export,
  versioned loss reports, and opt-in repository-local Git text conversion;
- proposed MIME definitions, Linux desktop-entry packaging scaffold, source
  icon, and clearly labelled IANA registration draft;
- desktop/mobile browser-rendered visual QA and automated accessibility QA.

### Adoption slice B

- signed and bundled LSP/CLI binaries for Windows, macOS, and Linux;
- VSIX plus Visual Studio Marketplace and Open VSX publishing;
- JetBrains plugin build, verifier matrix, and Marketplace publishing;
- native JetBrains Community baseline module;
- packaged Linux file associations and finalized application identifiers for
  later Windows and macOS registration;
- hosted Studio and landing page with immutable release downloads.

### Adoption slice C

- full Studio component reuse inside VS Code and JetBrains package editors;
- workspace asset refactors and safe rename support;
- CI templates for GitLab and generic shell runners, complementing the prepared
  GitHub Actions workflows;
- starter repository and migration guide from Markdown.

### Work that does not wait for repository publication

Parser, importer/exporter, Git text-conversion, conformance cases, Studio PWA
behavior, platform manifests, documentation, tests, local release archives,
and checksums can all be implemented and verified in the local monorepo. A
GitHub repository becomes necessary for public collaboration, hosted CI status,
release distribution, issue tracking, and marketplace automation—not for the
format or tools to function.

## 8. Success signals

Measure useful adoption without contradicting the local-first promise:

- Studio opens and successful local package saves;
- IDE extension installs and retained active installations;
- `notmarkdown verify` CI usage;
- example repository clones;
- documentation search terms and migration-guide completion.

Do not collect document content, asset names, package hashes, source paths, or
search queries. Prefer public aggregate download counts and opt-in anonymous
product telemetry with an explicit schema.

## 9. Source references for host capabilities

- VS Code Custom Editor API:
  https://code.visualstudio.com/api/extension-guides/custom-editors
- VS Code Language Server guide:
  https://code.visualstudio.com/api/language-extensions/language-server-extension-guide
- IntelliJ Platform LSP API and supported IDE constraints:
  https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html
