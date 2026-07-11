# Contributing to NotMarkdown

NotMarkdown is conformance-first. A change is complete only when prose,
schemas, fixtures, independent implementations, and user-facing diagnostics
agree.

## Before proposing a format change

1. State the user problem rather than only the desired syntax.
2. Explain how older readers behave.
3. Define the static fallback and accessibility behavior.
4. Add positive, negative, round-trip, and preservation fixtures.
5. Show that the change does not require network access or code execution.
6. Document import/export loss behavior.

Implementation behavior is not normative merely because one editor ships it.
Ambiguity should be resolved in the specification and conformance corpus, not
through implementation folklore.

## Compatibility promises

- `document.nmt` remains the human-readable authority.
- `.nmdoc` remains one ordinary portable sharing file.
- Documents remain inert and offline-capable.
- Unknown content is never silently dropped.
- Importers require an explicit source dialect where semantics differ.
- Exporters emit structured loss information.
- Formatting remains semantic and constrained by versioned themes.

## Pull-request checks

The prepared CI definitions test the Rust workspace on Linux, macOS, and
Windows and run the TypeScript reference-toolchain and Studio suites. Format
changes must additionally extend `conformance/`.

Implementation contributions are accepted under the repository's MIT license;
specification, grammar, schema, conformance, documentation, and example
contributions are dedicated under CC0-1.0 as described in
`LICENSE-POLICY.md`. Do not copy third-party fixtures without recording their
source and compatible license.

Keep commits focused and add a `Signed-off-by` trailer (`git commit -s`) to
confirm the Developer Certificate of Origin statement: you have the right to
submit the contribution under the project's licenses. Pull requests should
name exact verification commands and must not weaken the inert-document,
offline-correctness, path-safety, or explicit-loss guarantees.

Suspected vulnerabilities belong in GitHub's private vulnerability reporting
form, not a public issue. See `SECURITY.md`.
