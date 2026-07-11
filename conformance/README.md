# NotMarkdown conformance kit

This directory is the language-neutral starting point for testing independent
NotMarkdown implementations. It is intentionally small and pre-1.0. A case is
not a new format requirement: normative behavior comes from the specification
referenced by that case.

The kit currently records two kinds of work:

- `active` cases cover behavior already exercised by the TypeScript and/or
  Rust reference implementations.
- `draft` cases describe the next interoperability targets. They are excluded
  from the default run and may change until their implementation and
  specification wording have converged.

The two CommonMark cases are active after implementation and CLI-level
verification in the Rust 0.11 Compatibility Kit. The three synthetic
adversarial-package mutation cases remain drafts; they do not invent diagnostic
codes before a neutral mutation harness exists.

The catalogue currently contains 13 cases: 10 active interoperability cases
and three draft adversarial-package cases. The active set includes lossless,
inert Mermaid and Vega-Lite fenced-source parsing/import.

## Layout

```text
conformance/
  cases/                 one JSON file per case
  fixtures/              small inputs owned by this kit
  schema/                JSON Schema 2020-12 contracts
  scripts/validate.mjs   dependency-free structural validation
  runner-contract.md     adapter protocol and assertion semantics
  suite.json             ordered case catalogue
```

Cases may reuse repository fixtures instead of copying them. Every fixture path
is a forward-slash path relative to the repository root. A harness must reject
paths that escape that root.

## Validate the kit

From the repository root:

```sh
node conformance/scripts/validate.mjs
```

The script parses every JSON file, checks the case catalogue, validates the
documented required fields and enums, and verifies local fixture paths. It is a
lightweight bootstrap validator, not a replacement for full JSON Schema
validation. Implementations should validate cases against
`schema/case.schema.json` with a JSON Schema 2020-12 implementation.

## Implement an adapter

An implementation exposes its parser, importer, and package operations through
the JSON Lines protocol in `runner-contract.md`. The harness owns temporary
files, mutations, repeat builds, and assertions; the adapter owns format
behavior. This separation keeps cases independent of Rust, Node.js, a shell,
or a particular CLI spelling.

A partial implementation is useful. It advertises capabilities first and
returns `unsupported` for operations it does not implement. Skips are reported
and never silently treated as passes.

## Adding a case

1. Add a uniquely named `cases/*.case.json` file.
2. Reuse an existing fixture or add the smallest clear fixture under
   `fixtures/`.
3. Reference the relevant specification section when one exists.
4. Use `active` only when the behavior is implemented and testable.
5. Add the case path to `suite.json`.
6. Run `node conformance/scripts/validate.mjs`.

Assertions compare structured values, bytes, and stable diagnostic codes. They
must not compare human-readable error wording. Security fixtures must remain
inert data and must never be extracted outside the harness temporary directory.
