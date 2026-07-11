# Local release handoff

This directory prepares source artifacts before NotMarkdown has a GitHub home.
Its packaging and verification commands are deliberately offline: they read the
working tree, write a chosen local output directory, and do not invoke Git,
GitHub, a package registry, or any network client.

## Build the source release

Python 3.9 or newer is the only dependency. From the repository root on Linux or
macOS:

```sh
sh release/scripts/package-source.sh \
  --output-dir release/out/compatibility-kit-0.2.0
sh release/scripts/verify-release.sh \
  release/out/compatibility-kit-0.2.0
```

On Windows PowerShell:

```powershell
./release/scripts/package-source.ps1 `
  --output-dir release/out/compatibility-kit-0.2.0
./release/scripts/verify-release.ps1 `
  release/out/compatibility-kit-0.2.0
```

Every configured component is built by default. Select components or override a
version after its source version has changed:

```sh
sh release/scripts/package-source.sh \
  --output-dir release/out/cli-0.12.0 \
  --component rust \
  --set-version rust=0.12.0
```

The packager never overwrites an existing path. Choose a fresh output directory
for each run. `SOURCE_DATE_EPOCH` can override the fixed timestamp; the same
value must be used to reproduce the same bytes.

## What is deterministic

`release-config.json` defines component roots, versions and exclusions. Each ZIP
uses:

- bytewise-sorted UTF-8 paths below one versioned archive root;
- a single fixed UTC timestamp with ZIP's two-second precision;
- normalized `0644` file modes and `0755` modes for configured scripts;
- the `store` method, avoiding compressor-version differences across operating
  systems;
- no directory entries, comments, extra fields, symlinks or generated build
  directories.

The source bytes themselves are never rewritten. `release-manifest.json`
records each archive's version, size, file count, SHA-256 and content-tree
SHA-256. `SHA256SUMS` covers every ZIP and the manifest. The verifier rejects
extra or missing files, unsafe ZIP paths, duplicate entries, metadata drift and
content tampering.

The content-tree digest processes each sorted file as: eight-byte big-endian
UTF-8 path length, path bytes, eight-byte big-endian content length, then the
32-byte SHA-256 of the content.

Using stored ZIPs here does not constrain `.nmdoc` compression. These are small,
portable source handoff archives, not NotMarkdown document containers.

## Version handoff

The configuration currently creates one umbrella archive plus seven component
archives: format/conformance, Rust workspace, Studio, reference toolchain,
VS Code extension, JetBrains plugin and landing page. For components with a
native version file, packaging fails if the chosen version differs from that
file. This prevents a correctly checksummed but mislabelled archive.

If a component version changes after this handoff, either update its default in
`release-config.json` or pass `--set-version <component>=<final-version>`. The
override is intentionally explicit and is recorded in the generated manifest.

## Local validation

The dependency-free regression suite builds the same fixture twice, compares
every output byte, verifies metadata, checks executable normalization and proves
that tampering and version mismatches fail closed:

```sh
python3 -B -m unittest discover -s release/tests -v
```

The separate [GitHub publication checklist](GITHUB-PUBLICATION-CHECKLIST.md)
keeps today's offline preparation distinct from Sunday's deliberate online
actions.
