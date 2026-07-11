# Conformance runner contract 0.1

This contract lets one harness exercise implementations written in different
languages. It is an adapter protocol, not a public end-user CLI.

## Transport

The harness starts an adapter in JSON Lines mode. Standard input and standard
output contain exactly one UTF-8 JSON object per line. The adapter may write
human-readable logs to standard error.

Each request has a unique `requestId`. The response repeats that ID. Responses
are emitted in request order. An adapter exits with status 0 after a clean EOF;
process failure is a harness error, not a format rejection.

The request and response shapes are defined by
`schema/runner-protocol.schema.json`.

## Capability handshake

The first request uses operation `capabilities`. The completed response places
this data under `data`:

```json
{
  "implementation": {
    "name": "example-reader",
    "version": "0.1.0"
  },
  "operations": [
    "parse-source",
    "open-package"
  ]
}
```

An adapter must return `status: "unsupported"` for an unadvertised operation.
The harness records that as skipped, not passed.

## Operation requests

After reading a case, the harness resolves repository-relative fixture paths,
decodes inline base64 fixtures, and applies any declared mutation in a private
temporary directory. It then sends absolute fixture paths to the adapter.
The adapter receives no path outside that directory or the read-only checkout.

Initial operation names are:

- `parse-source`: parse a `.nmt` source into normalized CDM.
- `import-markdown`: import the explicitly supplied Markdown dialect.
- `open-package`: structurally open and inspect a `.nmdoc` package.
- `create-package`: create a package from source and asset fixtures.
- `verify-package`: verify all declared representations.
- `compare-package-builds`: create the same package `repetitions` times and
  report whether the resulting bytes are identical.

Operation-specific options live in `parameters`. Unknown parameters are an
adapter error; adapters must not guess their meaning.

## Normalized response data

A completed or rejected operation returns the fields it can establish under
`data`. The following names are reserved so cases can use stable JSON Pointers:

```json
{
  "document": {},
  "source": "@notmarkdown 0.1\n",
  "package": {
    "manifest": {},
    "entries": []
  },
  "builds": [
    { "sha256": "lowercase hex", "bytes": 123 }
  ],
  "observations": {
    "byteEqualRebuilds": true,
    "packageVerifies": true
  },
  "losses": [
    {
      "code": "implementation-defined-until-specified",
      "sourcePath": "/blocks/1",
      "message": "Human-readable explanation"
    }
  ]
}
```

Not every operation returns every field. Package bytes are written to a
harness-provided output path rather than embedded in JSON. `sha256` describes
the exact bytes at that path.

`outcome: "rejected"` is an expected format-level result and may include
diagnostics. `status: "error"` is reserved for adapter/protocol/I/O failures.

Diagnostics use this minimum structure:

```json
{
  "code": "NMD_HEADER_REQUIRED",
  "severity": "error",
  "range": {
    "start": { "line": 1, "column": 1 },
    "end": { "line": 1, "column": 1 }
  },
  "message": "Wording is not compared by the harness"
}
```

Only codes explicitly required by a case are compared. Message text and repair
suggestion wording are never conformance assertions.

## Assertion evaluation

The harness creates one observation object by combining the response:

```json
{
  "outcome": "accepted",
  "document": {},
  "source": "...",
  "package": {},
  "builds": [],
  "observations": {},
  "losses": [],
  "diagnostics": []
}
```

JSON Pointers use RFC 6901. The initial operators are:

- `equals`: the value at `pointer` is JSON-deep-equal to `value`.
- `not-equals`: it is not JSON-deep-equal to `value`.
- `array-length`: the selected value is an array of length `value`.
- `contains-code`: the selected array has an object whose `code` equals
  `value`.
- `matches-schema`: the selected value validates against the repository-relative
  JSON Schema path in `value`.

The case's top-level `expected.outcome` is always checked before its assertions.
All assertions run so one result can report every mismatch.
A pointer that does not resolve is an assertion failure; it is not treated as
`null` or an empty collection.

## Determinism

For `compare-package-builds`, the harness provides the same bytes and options on
every repetition. The adapter writes each result separately and compares the
complete byte sequences, not just semantic contents. It reports hashes for
debugging and `observations.byteEqualRebuilds` for the assertion.

The harness must not introduce changing timestamps, paths, environment data, or
random values into a repeated request.

## Draft mutations

Adversarial cases currently reserve these harness-side mutation names:

- `flip-entry-payload-byte`
- `append-duplicate-entry`
- `append-unsafe-path-entry`

Their exact ZIP transformation recipes remain draft. They are not part of the
default run until byte fixtures or deterministic mutation algorithms have been
reviewed against at least two readers.

## Isolation

Conformance runs are offline. They do not follow external links, execute code
blocks, render active HTML, launch embedded media, or extract arbitrary archive
paths. Every produced artifact is disposable unless the harness explicitly
retains it for a failure report.
