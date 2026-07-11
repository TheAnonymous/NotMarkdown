# Security policy

NotMarkdown treats every document as untrusted input.

## Security invariants

- no scripts, macros, notebook cells, or extension code execute from a document;
- package paths cannot escape the package or extraction destination;
- readers enforce entry-count, size, compression-ratio, and allocation limits;
- local and central ZIP headers, declared sizes, CRC-32, and SHA-256 agree;
- unsupported compression methods and flags are rejected;
- attachments remain inert until an explicit user action opens or extracts them;
- remote resources are never required for correctness and are not fetched
  without explicit user consent;
- deferred representations cannot be rendered, indexed, extracted, or rewritten
  before verification;
- import and export never silently discard unsupported semantics.
- declarative diagram and chart source is bounded and rejected before a
  renderer sees configuration, interactions, active markup, remote or relative
  resources, expressions, transforms, or unsupported chart composition;
- generated SVG is sanitized and displayed through a Blob-backed image rather
  than inserted into the application DOM as inline SVG;
- Studio ships a restrictive Content Security Policy; `wasm-unsafe-eval` is
  limited to the local Zstandard WebAssembly codec.

## Supported versions

The current `main` branch and the newest `0.2.x` release candidate receive
security fixes. Older prototypes are unsupported and should not be used for
processing untrusted documents.

## Private reports

Use the repository's [private vulnerability reporting
form](https://github.com/TheAnonymous/NotMarkdown/security/advisories/new).
Do not open a public issue for a suspected vulnerability and do not attach a
private document unless it has been reduced to the minimum bytes needed to
reproduce the problem.

Include the affected component and version, platform, exact resource usage,
whether the input crosses a trust boundary, and a minimal reproducer. The
maintainer aims to acknowledge a valid private report within 72 hours and will
coordinate disclosure after a fix or documented mitigation is available.

## Scope for hardening

The parser, ZIP reader, codecs, HTML renderer, media metadata pipeline, file
handlers, preview extensions, and Git filters all process attacker-controlled
bytes and belong in the fuzzing and adversarial-fixture matrix.
