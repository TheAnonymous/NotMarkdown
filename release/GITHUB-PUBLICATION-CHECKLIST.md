# NotMarkdown release-candidate runbook

This runbook covers the public prerelease pipeline in
`TheAnonymous/NotMarkdown`. The format remains a 0.1 draft. Release assets are
unsigned; GitHub build-provenance attestations do not replace platform code
signing.

## Current versions

| Component | Version | Release role |
| --- | ---: | --- |
| Format, schemas, grammar | 0.1 | Draft specification |
| Compatibility Kit | 0.2.0 | Public RC umbrella |
| Rust CLI/LSP/TUI | 0.12.0 | Six native archives |
| Reference toolchain | 0.6.0 | Source archive/conformance oracle |
| Browser Studio | 0.7.0 | Local-first browser editor source |
| VS Code extension | 0.2.0 | Installable VSIX and source |
| JetBrains plugin | 0.1.0 | Source scaffold only |
| Landing page | 0.3.0 | GitHub Pages source |

Public project surfaces:

- repository: `https://github.com/TheAnonymous/NotMarkdown`;
- landing page: `https://theanonymous.github.io/NotMarkdown/`;
- issues: `https://github.com/TheAnonymous/NotMarkdown/issues`.

## 1. Release authority and stop checks

Before changing `release/release-trigger.json`:

- [ ] contributor and bundled-asset publication rights are confirmed;
- [ ] MIT/CC0 policy and third-party notices are reviewed for the exact tree;
- [ ] `SECURITY.md` contains a real monitored private contact;
- [ ] credential/large-file scans have no unexplained result;
- [ ] release notes describe unsigned archives, prototypes, and the 0.1 draft
      boundary accurately;
- [ ] the exact `main` commit has green Node/Rust checks;
- [ ] repository Actions permissions default to read-only and branch protection
      is active.

The release workflow receives write access only in two isolated places:
`attestations`/`id-token` in the assembly job and `contents` in the final
prerelease job. No Marketplace or package-registry secret is read.

## 2. Local verification

Run from the repository root:

```sh
node conformance/scripts/validate.mjs
python3 -B -m unittest discover -s release/tests -v

(cd notmarkdown-reference-parser && npm ci && npm run check)
(cd notmarkdown-web-editor && npm ci && npm run check)
(cd notmarkdown-vscode && npm ci && npm run check && npm run package)
python3 -B release/scripts/verify_vsix.py \
  notmarkdown-vscode/notmarkdown-vscode-0.2.0.vsix

(cd notmarkdown-rust && cargo +1.97.0 fmt --all -- --check)
(cd notmarkdown-rust && cargo +1.97.0 test --workspace --locked)
(cd notmarkdown-rust && cargo +1.97.0 clippy --workspace --all-targets \
  --locked -- -D warnings)
```

- [ ] every available command exits zero;
- [ ] `git diff --check` exits zero;
- [ ] generated `node_modules`, `dist`, `target`, VSIX, caches, and temporary
      release outputs are not staged;
- [ ] the VSIX contains LICENSE, README, changelog, icon, grammar, snippets, and
      `dist/extension.js`, but no source, tests, dependencies, or source maps;
- [ ] the JetBrains verifier limitation is recorded if Gradle/IDE artifacts are
      unavailable locally.

## 3. Deterministic source rehearsal

```sh
python3 -B release/scripts/package_sources.py \
  --root . --config release/release-config.json \
  --output-dir /tmp/notmarkdown-source-a
python3 -B release/scripts/package_sources.py \
  --root . --config release/release-config.json \
  --output-dir /tmp/notmarkdown-source-b
python3 -B release/scripts/verify_release.py /tmp/notmarkdown-source-a
python3 -B release/scripts/verify_release.py /tmp/notmarkdown-source-b
diff -qr /tmp/notmarkdown-source-a /tmp/notmarkdown-source-b
```

- [ ] both fresh output directories are byte-identical;
- [ ] `release-manifest.json` contains exactly the configured components;
- [ ] no archive contains `.git`, credentials, dependencies, caches, generated
      build trees, a VSIX, or an unsafe path;
- [ ] source archives retain the fixed 1980 timestamp and normalized modes.

## 4. Public RC trigger

`release/release-trigger.json` is the only `main`-branch path that triggers the
online release workflow. Confirm `compatibility_version` equals
`release-config.json`, then increment `release_candidate` to a number that has
never been used. The workflow derives:

```text
compatibility-kit-v<compatibility_version>-rc.<release_candidate>
```

Commit and push the reviewed trigger change. Do not pre-create or move its tag.
The workflow fails if either the derived tag or release already exists; new
bytes always require a new RC number.

The matrix then:

1. validates versions and the committed trigger;
2. builds the reference parser and runs `cargo test --workspace --locked` plus
   a CLI import/export/pack/verify determinism smoke on Linux;
3. builds CLI, LSP, and TUI on Linux, macOS, and Windows for x64 and arm64;
4. builds deterministic source archives and verifies them;
5. builds the VSIX, runs its tests, and verifies its exact payload;
6. merges all assets, renders Homebrew/WinGet/Scoop/AUR manifests from final
   URLs and hashes, and writes final `SHA256SUMS`;
7. creates keyless build-provenance attestations with `actions/attest@v4`;
8. creates a public GitHub prerelease and its new tag at the green commit.

- [ ] all jobs are green, including both arm64 preview runners;
- [ ] logs contain no environment dump, token, skipped mandatory test, or
      unexpected mutable third-party action;
- [ ] the release is marked prerelease and not Latest;
- [ ] the tag targets the exact workflow commit;
- [ ] no npm, Marketplace, package-manager, app-store, or desktop-installer
      publication occurred.

## 5. Asset and provenance verification

Download every asset into a clean directory. The release includes:

- six `notmarkdown-tools-0.12.0-<target>` native archives;
- eight deterministic source archives, `release-manifest.json`, and the source
  checksum record;
- `notmarkdown-vscode-0.2.0.vsix`;
- rendered Homebrew, WinGet, Scoop, and AUR review files;
- final `SHA256SUMS`.

```sh
sha256sum --check SHA256SUMS
gh attestation verify <asset> -R TheAnonymous/NotMarkdown
```

- [ ] every checksum passes;
- [ ] every asset has a valid attestation for this repository;
- [ ] native archives contain only CLI, LSP, TUI, and MIT license below one
      versioned top-level directory;
- [ ] executable modes are present in Unix archives;
- [ ] `notmarkdown --version`, `notmarkdown-lsp`, and `notmd-tui` start on each
      supported operating-system/architecture pair;
- [ ] rendered package-manager paths match the archive layout exactly.

## 6. Separate distribution channels

GitHub prerelease success does not authorize another channel.

- VS Code Marketplace requires the registered `notmarkdown` publisher, a
  narrowly scoped `VSCE_PAT`, and manual install verification of the exact VSIX.
- JetBrains Marketplace requires Gradle verifier success, Marketplace
  organisation ownership, `PUBLISH_TOKEN`, and plugin-signing key custody.
- Homebrew Core, WinGet, Scoop, and AUR files are submission inputs only.
- The Tauri desktop project is an unbundled scaffold. Windows signing, Apple
  notarization, Linux packaging/signing, updater keys, and installer lifecycle
  tests are mandatory before shipping it.

## 7. Stable promotion

Never mutate or overwrite an RC tag/release. A stable release requires a new,
reviewed stable tag and a separate explicit promotion decision after public RC
smoke testing. Record the commit SHA, tag SHA, release URL, timestamp, approver,
checksum result, attestation result, and known limitations in the release
evidence.
