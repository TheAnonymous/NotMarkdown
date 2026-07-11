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

## Reports

Until a public security address and repository issue policy exist, keep a
reproducer private and record the affected component, version, platform,
resource usage, and whether the input crosses a trust boundary. The public
repository must establish a private reporting channel before its first stable
release.

## Scope for hardening

The parser, ZIP reader, codecs, HTML renderer, media metadata pipeline, file
handlers, preview extensions, and Git filters all process attacker-controlled
bytes and belong in the fuzzing and adversarial-fixture matrix.
