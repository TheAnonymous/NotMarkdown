# Local release handoff

This directory contains the offline source packager and the public GitHub
release-candidate handoff. The packaging and verification commands in
`release/scripts/` remain deliberately offline: they read the working tree,
write a chosen local output directory, and do not invoke Git, GitHub, a package
registry, or any network client.

The separate `.github/workflows/release.yml` is the online release path. It
builds unsigned native tools for Linux, macOS, and Windows on x64 and arm64,
packages and verifies the VS Code extension, merges the deterministic source
archives, renders package-manager manifests from the final URLs and hashes,
writes one final `SHA256SUMS`, and attests every asset.

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
keeps offline reproducibility checks distinct from credentialed online actions.

## Automated release candidate

A push to `main` runs the release workflow only when
`release/release-trigger.json` changes. That committed file supplies the
Compatibility Kit version and positive release-candidate number; the workflow
derives `compatibility-kit-v<version>-rc.<number>` and rejects version drift.
Tag pushes and manual dispatches remain supported validation paths.

After all six native builds, source packaging, and VSIX verification succeed,
the workflow creates a new public GitHub prerelease. It fails closed if either
the derived tag or release already exists; any changed bytes require a higher
committed release-candidate number. It does not publish to VS Code or
JetBrains Marketplace, Homebrew Core, WinGet, Scoop, AUR, or an app store.

Release assets are unsigned until platform signing identities exist. GitHub's
keyless build-provenance attestation can be verified independently after
download:

```sh
gh attestation verify <downloaded-asset> -R TheAnonymous/NotMarkdown
sha256sum --check SHA256SUMS
```

The desktop wrapper under `integrations/desktop/` remains an unbundled scaffold
and is deliberately absent from this release matrix.
