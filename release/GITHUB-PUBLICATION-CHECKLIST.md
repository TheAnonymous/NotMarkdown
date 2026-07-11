# NotMarkdown GitHub publication checklist

Target handoff: Sunday, 2026-07-12 (`Europe/Oslo`). This is a runbook, not a
publication record. Every checkbox starts unchecked deliberately.

> **Current status:** no GitHub repository has been created, no remote has been
> added, and no commit, tag, push, release, registry publication, marketplace
> upload, deployment, signing request, DNS change, or media-type registration
> has been performed by this preparation work.

The first half can be completed entirely on a local machine. The section marked
**Online** is intentionally reserved for the project owner to run when network
access and the GitHub account are available.

## 0. Set the release variables

Use one shell for the run and replace every angle-bracket value. The component
values below are the current local defaults, not promises that they are the
versions ultimately published.

```sh
export GITHUB_OWNER="<account-or-organisation>"
export REPO_NAME="notmarkdown"
export GITHUB_REPO="$GITHUB_OWNER/$REPO_NAME"
export DEFAULT_BRANCH="main"
export HOMEPAGE_URL="<https-url-or-empty>"

export FORMAT_VERSION="0.1"
export COMPAT_VERSION="0.1.0"
export RUST_VERSION="0.11.0"
export REFERENCE_VERSION="0.5.0"
export STUDIO_VERSION="0.6.2"
export VSCODE_VERSION="0.1.0"
export JETBRAINS_VERSION="0.1.0"
export SITE_VERSION="0.2.0"

export RELEASE_TAG="compatibility-kit-v$COMPAT_VERSION"
export RELEASE_TITLE="NotMarkdown Compatibility Kit $COMPAT_VERSION"
export ARTIFACT_DIR="release/out/compatibility-kit-$COMPAT_VERSION"
export REPEAT_ARTIFACT_DIR="$ARTIFACT_DIR.repeat"
export RELEASE_NOTES="release/RELEASE-NOTES.md"
export SOURCE_DATE_EPOCH="315532800"
```

Current components that must be represented in the release notes:

| Component | Current local version | Publication role |
| --- | ---: | --- |
| Format draft, schemas, and grammar | 0.1 | Normative draft |
| Rust core, package codec, CLI, LSP, and TUI | 0.11.0 | Native toolchain |
| TypeScript reference toolchain | 0.5.0 | Independent implementation |
| Browser Studio/PWA | 0.6.2 | Local-first browser editor |
| VS Code extension | 0.1.0 | Installable prototype |
| JetBrains extension | 0.1.0 | Source scaffold/prototype |
| Landing page | 0.2.0 | Static product site |
| Compatibility Kit | 0.1.0 release candidate | Source-release umbrella |

- [ ] Replace every placeholder and confirm `GITHUB_REPO` points to the intended
      owner, not a personal test account.
- [ ] Reconcile these values with `Cargo.toml`, all `package.json` files,
      `build.gradle.kts`, the root `README.md`, release notes, artifact names, and
      the tag. Stop if any public-facing version disagrees.
- [ ] Treat `release/release-config.json` as the packaging input and the generated
      `release-manifest.json` as the authority for the artifact set actually
      uploaded; never infer versions only from filenames.
- [ ] Confirm the Compatibility Kit promotion from the root's earlier `0.1-dev`
      status to the configured `0.1.0` release candidate; do not tag it as stable
      accidentally.

## 1. Offline/local stop gates — no publication permitted yet

### Gate A: licensing ownership and terms

The project-wide license decision is recorded in `LICENSE-POLICY.md`: MIT for
implementation code and CC0-1.0 for specifications and conformance material.

- [ ] Confirm every contributor has the right to publish their contribution and
      every included example/media file has a recorded origin and usable terms.
- [x] Choose and add the project license files: MIT for code and CC0-1.0 for
      specification/conformance material.
- [x] Add the authoritative root license files and SPDX identifiers, then align
      the Rust crates, npm packages, VS Code extension, JetBrains plugin, and
      documentation metadata with that decision.
- [ ] Review dependency and bundled-asset notices; add `NOTICE` or third-party
      attribution where required.
- [ ] Confirm the release notes call the 0.1 format a draft and do not imply an
      IANA-approved media type.
- [ ] Record the license decision in the release sign-off below.

**STOP:** do not create a public repository or public release until every item
in Gate A is complete.

### Gate B: private security contact

This is also a hard stop. `SECURITY.md` must name a real, monitored private
reporting route before publication; a placeholder or an unattended mailbox is
not sufficient.

- [ ] Choose a monitored security email or equivalent private contact, assign
      at least one responsible person, and test receipt and reply.
- [ ] Update `SECURITY.md` with the exact contact, supported versions, expected
      acknowledgement window, disclosure process, and what reporters should
      include.
- [ ] Decide who can access GitHub Security Advisories and who is responsible
      for dependency alerts and emergency releases.
- [ ] Plan to create the GitHub repository as **private first**, enable private
      vulnerability reporting and security controls, verify them, and only then
      change repository visibility to public.
- [ ] Record the security owner/contact confirmation in the release sign-off.

**STOP:** do not change repository visibility to public until Gate B is complete
and its online settings have been verified in the private repository.

### Gate C: scope, credentials, and generated files

Run these checks from the canonical repository root. They inspect local files
only.

```sh
pwd
rg --hidden -n -i \
  --glob '!**/node_modules/**' --glob '!**/target/**' --glob '!**/.git/**' \
  '(api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|password\s*[=:])' .
find . -type f -size +25M -not -path './.git/*' -print
find . -type f \( -name '*.pem' -o -name '*.p12' -o -name '*.pfx' \
  -o -name 'id_rsa*' -o -name '.env*' \) -print
```

- [ ] Review every match manually; scanners produce false positives, but no
      unexplained credential-like value may remain.
- [ ] Confirm archives contain no `.git`, `.env`, editor history, private notes,
      credentials, `node_modules`, Rust `target`, Gradle caches, or machine-local
      absolute paths.
- [ ] Confirm `.gitignore` covers generated build trees while intentionally
      retaining release source, checksums, schemas, fixtures, and this runbook.
- [ ] Confirm all examples and adversarial fixtures are inert and contain no
      personal data.

## 2. Offline/local verification

No command in this section pushes or publishes. Use Node.js 24 and the pinned
Rust 1.97 toolchain. `--offline` is deliberate: if a clean dependency install
cannot be reproduced from an already warmed cache, leave the item unchecked
and repeat it during the private online verification phase.

### Toolchain identity

```sh
node --version
npm --version
rustc +1.97.0 --version
cargo +1.97.0 --version
gradle --version
```

- [ ] Record the operating system, CPU architecture, Node/npm versions, Rust
      versions, Gradle/JDK versions, and command output in the release evidence.

### Source, schema, and conformance checks

```sh
node conformance/scripts/validate.mjs

(cd notmarkdown-reference-parser && npm ci --offline && npm run check)
(cd notmarkdown-web-editor && npm ci --offline && npm run check)
(cd notmarkdown-vscode && npm ci --offline && npm run check)
(cd notmarkdown-site && npm run check)

(cd notmarkdown-rust && cargo +1.97.0 fmt --all -- --check)
(cd notmarkdown-rust && cargo +1.97.0 test --workspace --locked --offline)
(cd notmarkdown-rust && cargo +1.97.0 clippy --workspace --all-targets \
  --locked --offline -- -D warnings)
(cd notmarkdown-rust && cargo +1.97.0 build --release --locked --offline \
  -p notmarkdown-cli -p notmarkdown-tui -p notmarkdown-lsp)

(cd notmarkdown-jetbrains && gradle --offline buildPlugin verifyPlugin)
```

- [ ] Every command exits zero from a clean dependency tree, or the precise
      cache-only limitation is recorded for rerun while the repository is
      private.
- [ ] No test rewrites a committed fixture or leaves an unexplained file change.
- [ ] Inspect `git diff --exit-code` after verification once the local repository
      has been initialised.

### Compatibility smoke tests

Use a disposable directory and the just-built native CLI. These commands are
examples to run; their presence here is not evidence that they succeeded.

```sh
export NOTMARKDOWN_BIN="$PWD/notmarkdown-rust/target/release/notmarkdown"
export SMOKE_DIR="$(mktemp -d)"

printf '# Import smoke\n\n1. alpha\n2. beta\n' > "$SMOKE_DIR/input.md"
"$NOTMARKDOWN_BIN" import "$SMOKE_DIR/input.md" \
  --dialect commonmark --to nmt --output "$SMOKE_DIR/imported.nmt" \
  --loss-report "$SMOKE_DIR/import-loss.json"
"$NOTMARKDOWN_BIN" export "$SMOKE_DIR/imported.nmt" \
  --to markdown --output "$SMOKE_DIR/exported.md" \
  --loss-report "$SMOKE_DIR/markdown-loss.json"
"$NOTMARKDOWN_BIN" export "$SMOKE_DIR/imported.nmt" \
  --to html --output "$SMOKE_DIR/exported.html" \
  --loss-report "$SMOKE_DIR/html-loss.json"
"$NOTMARKDOWN_BIN" parse "$SMOKE_DIR/imported.nmt"
"$NOTMARKDOWN_BIN" git source "$SMOKE_DIR/imported.nmt"

"$NOTMARKDOWN_BIN" pack "$SMOKE_DIR/imported.nmt" \
  --profile modern --output "$SMOKE_DIR/a.nmdoc"
"$NOTMARKDOWN_BIN" pack "$SMOKE_DIR/imported.nmt" \
  --profile modern --output "$SMOKE_DIR/b.nmdoc"
cmp "$SMOKE_DIR/a.nmdoc" "$SMOKE_DIR/b.nmdoc"
"$NOTMARKDOWN_BIN" verify "$SMOKE_DIR/a.nmdoc"
```

- [ ] Inspect every loss report as JSON and confirm unsupported semantics are
      explicit; an empty report must mean genuinely lossless conversion.
- [ ] Confirm HTML export is inert, self-contained, contains no executable
      script, and requires no network request for correctness.
- [ ] Confirm two identical package inputs produce byte-identical `.nmdoc`
      outputs under the same format/profile/tool version.
- [ ] Test both declared import dialects (`commonmark` and `github`) and both
      package profiles (`modern` and `portable`).
- [ ] Test malformed UTF-8, unsafe ZIP paths, duplicate entries, tampered
      representations, unsupported compression, and bounded-resource failures.

### Git integration in a disposable repository

```sh
mkdir "$SMOKE_DIR/git-repo"
git -C "$SMOKE_DIR/git-repo" init --initial-branch=main
"$NOTMARKDOWN_BIN" git install --local "$SMOKE_DIR/git-repo"
cp "$SMOKE_DIR/a.nmdoc" "$SMOKE_DIR/git-repo/document.nmdoc"
cp "$SMOKE_DIR/imported.nmt" "$SMOKE_DIR/git-repo/document.nmt"
git -C "$SMOKE_DIR/git-repo" check-attr diff -- \
  document.nmdoc document.nmt
git -C "$SMOKE_DIR/git-repo" config --local --get diff.notmarkdown.textconv
git -C "$SMOKE_DIR/git-repo" diff --textconv -- \
  document.nmdoc document.nmt
```

- [ ] Confirm installation modifies only the disposable repository's local Git
      configuration/attributes and can be reviewed as text.
- [ ] Confirm `.nmdoc` diffs use deterministic source/semantic text and never
      execute document content or fetch network resources.
- [ ] Confirm paths containing spaces and non-ASCII characters work on Linux,
      macOS, Windows Command Prompt, and PowerShell before claiming full
      cross-platform Git support.

## 3. Deterministic source artifacts and checksums

The current local packager intentionally creates source handoff archives only.
It does **not** create signed native binaries, a built VSIX, a built JetBrains
plugin, an installer, or a hosted Studio. Do not imply otherwise in release
notes. The configured asset set is:

```text
notmarkdown-compatibility-kit-<COMPAT_VERSION>-source.zip
notmarkdown-format-<FORMAT_VERSION>-source.zip
notmarkdown-rust-<RUST_VERSION>-source.zip
notmarkdown-studio-<STUDIO_VERSION>-source.zip
notmarkdown-reference-toolchain-<REFERENCE_VERSION>-source.zip
notmarkdown-vscode-<VSCODE_VERSION>-source.zip
notmarkdown-jetbrains-<JETBRAINS_VERSION>-source.zip
notmarkdown-landing-<SITE_VERSION>-source.zip
release-manifest.json
SHA256SUMS
```

Run the dependency-free packager tests, produce two independent output trees,
verify each tree, and compare every output byte:

```sh
python3 -B -m unittest discover -s release/tests -v

sh release/scripts/package-source.sh \
  --output-dir "$ARTIFACT_DIR" \
  --set-version rust="$RUST_VERSION"
sh release/scripts/package-source.sh \
  --output-dir "$REPEAT_ARTIFACT_DIR" \
  --set-version rust="$RUST_VERSION"

sh release/scripts/verify-release.sh "$ARTIFACT_DIR"
sh release/scripts/verify-release.sh "$REPEAT_ARTIFACT_DIR"
diff -qr "$ARTIFACT_DIR" "$REPEAT_ARTIFACT_DIR"
cmp "$ARTIFACT_DIR/release-manifest.json" \
  "$REPEAT_ARTIFACT_DIR/release-manifest.json"
cmp "$ARTIFACT_DIR/SHA256SUMS" \
  "$REPEAT_ARTIFACT_DIR/SHA256SUMS"
```

On Windows, run the equivalent `release/scripts/package-source.ps1` and
`release/scripts/verify-release.ps1` commands in PowerShell with the same output
directories, versions, and `SOURCE_DATE_EPOCH`.

- [ ] The packager's unit/regression suite exits zero.
- [ ] Both packaging runs start with nonexistent output directories; a stale
      directory is not silently reused or mixed into a new release.
- [ ] Both verifiers exit zero and `diff`/`cmp` report byte-identical outputs.
- [ ] Inspect `release-manifest.json`; confirm it contains exactly the seven
      component archives plus the umbrella archive, expected versions, archive
      sizes, file counts, SHA-256 values, and content-tree SHA-256 values.
- [ ] Confirm the packaging timestamp and `SOURCE_DATE_EPOCH` are fixed once for
      both runs. The configured 1980 epoch is acceptable for reproducible source
      ZIPs; if it is changed, record the one chosen value and rebuild both trees.
- [ ] Confirm the compatibility-kit archive is built from the configured
      inventory and that exclusions remove `.git`, `release/out`, caches,
      dependencies, and generated build trees.
- [ ] Open every ZIP with a second ZIP implementation and reject absolute paths,
      `..`, duplicates, comments, extra fields, symlinks, metadata drift,
      unsupported methods, or surprising executable bits.
- [ ] Re-run `verify-release` after copying the canonical artifact directory to
      a third clean location.
- [ ] Author `$RELEASE_NOTES` separately and confirm it calls this a source
      handoff, states supported/prototype status honestly, and does not advertise
      binary installers or hosted deployment.
- [ ] If binary/VSIX/plugin/web assets are added later, give them a separate
      reviewed build/signing matrix and extend `release-manifest.json` and
      `SHA256SUMS`; never drop unmanifested files into the GitHub upload glob.

## 4. Create the local Git history — still offline

Do this only after Gates A–C and local verification are complete. If this tree
already has an intentional Git history, inspect it and skip `git init`; never
replace it.

```sh
test -d .git || git init --initial-branch="$DEFAULT_BRANCH"
git branch -M "$DEFAULT_BRANCH"
git status --short
git add --all
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "Prepare NotMarkdown Compatibility Kit $COMPAT_VERSION"
git status --short
git log -1 --show-signature --stat
```

- [ ] Review the complete staged patch, not only the summary.
- [ ] Confirm generated caches/build trees are absent and every intended schema,
      fixture, integration scaffold, workflow, release file, and lockfile is
      present.
- [ ] Decide whether `release/out/` is intentionally committed. The recommended
      default is to ignore local outputs and upload the verified files as release
      assets; do not let `git add --all` stage them accidentally.
- [ ] Confirm the committed author identity and email are suitable for public
      history.
- [ ] Require a clean worktree after the commit.
- [ ] Do not add an `origin`, create a tag, or push during offline preparation.

## 5. Online — project owner runs these steps

Everything below changes GitHub or downloads dependencies. It is intentionally
separate from local readiness.

### Authenticate and create a private repository

```sh
gh auth status
gh repo create "$GITHUB_REPO" --private --source=. --remote=origin
git remote -v
git push -u origin "$DEFAULT_BRANCH"
```

- [ ] Authenticate using the minimum necessary GitHub scopes; do not paste a
      token into a tracked file or shell command that will be retained in
      history.
- [ ] Verify the new repository is **private**, has the expected owner/name, and
      contains the exact local commit SHA.
- [ ] Set the description, optional homepage, topics, and default branch.
- [ ] Disable the wiki and unused features; enable Issues/Discussions only when
      someone will triage them.
- [ ] Set default GitHub Actions workflow permissions to read-only and require
      approval for workflows from first-time external contributors.
- [ ] Enable Dependabot/security alerts appropriate to the repository.
- [ ] Enable GitHub private vulnerability reporting and verify that the chosen
      security maintainers can access a test draft advisory.
- [ ] Add the confirmed security contact to repository metadata or
      `SECURITY.md`, without exposing a private personal address unintentionally.

### Rerun clean checks in the private repository

- [ ] Let both committed workflows run on Linux, macOS, and Windows.
- [ ] Rerun any offline cache misses with normal dependency installation
      (`npm ci`, Cargo `--locked`, and Gradle verification) while the repository
      remains private.
- [ ] Inspect every workflow log for warnings, accidental environment dumps,
      unpinned mutable release inputs, skipped tests, and platform-specific
      failures.
- [ ] Require green Node and Rust checks for the exact release commit.
- [ ] If a fix is required, commit it, push it, rerun the full matrix, rebuild
      artifacts, and regenerate checksums. Never move a published tag later.

### Configure repository governance before public visibility

- [ ] Add a branch ruleset for `main`: block force pushes and deletion, require
      pull requests for future changes, require conversation resolution, and
      require the actual Node/Rust status-check names observed on GitHub.
- [ ] Ensure administrators are covered unless an explicitly documented
      emergency policy says otherwise.
- [ ] Confirm `CONTRIBUTING.md`, `SECURITY.md`, licenses, roadmap, version matrix,
      and release notes render correctly on GitHub.
- [ ] Confirm no Pages deployment, package publication, marketplace publication,
      signing action, or IANA submission is enabled implicitly.

### Tag and stage the release while private

Create an immutable annotated tag only after the private CI matrix is green. A
signed tag is preferred when a verified signing identity is already available;
do not invent a signing identity on release day.

```sh
git switch "$DEFAULT_BRANCH"
git pull --ff-only origin "$DEFAULT_BRANCH"
git status --short
git tag -s "$RELEASE_TAG" -m "$RELEASE_TITLE"
git push origin "$RELEASE_TAG"
gh release create "$RELEASE_TAG" "$ARTIFACT_DIR"/* \
  --repo "$GITHUB_REPO" --verify-tag --draft \
  --title "$RELEASE_TITLE" --notes-file "$RELEASE_NOTES"
```

If signed tags are not yet configured, use `git tag -a` and state that fact in
the release evidence rather than presenting it as signed.

- [ ] Verify the tag points to the exact green commit and its annotation/version
      matches every artifact.
- [ ] Inspect the draft release asset names, sizes, checksums, notes, supported
      platforms, prerelease/stable classification, and source links.
- [ ] Download the draft assets into a clean directory and verify `SHA256SUMS`
      before making anything public.
- [ ] Keep npm, VS Code Marketplace, JetBrains Marketplace, package-manager,
      container-registry, and app-store publishing out of this first action
      unless separately reviewed credentials, identities, signing, and rollback
      plans exist.

### Final public-visibility gate

All answers must be yes before running the visibility command:

- [ ] Gate A licensing is signed off.
- [ ] Gate B security contact and private reporting are tested.
- [ ] Gate C content/credential review is signed off.
- [ ] Exact release commit is green on Linux, macOS, and Windows.
- [ ] Repeat builds and downloaded draft assets match `SHA256SUMS`.
- [ ] Root README version matrix and all release notes are accurate.
- [ ] At least two people have reviewed public visibility, or the owner has
      explicitly recorded why a solo release is intentional.

```sh
gh repo edit "$GITHUB_REPO" --visibility public \
  --accept-visibility-change-consequences
gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPO" \
  --draft=false --latest
```

- [ ] Confirm the repository is anonymously readable before publishing the
      draft release; if not, stop and diagnose permissions.
- [ ] Publish the release only after the public repository check succeeds.
- [ ] Record the public repository URL, commit SHA, tag object SHA, release URL,
      publication timestamp/timezone, and approver.

## 6. Post-publication smoke checks

Use an incognito browser and a fresh shell/container without GitHub credentials
where possible. Authentication-backed `gh` output alone does not prove public
availability.

```sh
export PUBLIC_URL="https://github.com/$GITHUB_REPO"
export ANON_DIR="$(mktemp -d)"
git clone "$PUBLIC_URL.git" "$ANON_DIR/notmarkdown"
git -C "$ANON_DIR/notmarkdown" rev-parse HEAD
curl -fsSL \
  "https://api.github.com/repos/$GITHUB_REPO/releases/tags/$RELEASE_TAG"
```

- [ ] Anonymous clone resolves to the expected commit and the release endpoint
      resolves to the expected tag.
- [ ] README links, license links, security policy, contribution guide, schemas,
      examples, screenshots, landing-page links, and release download links work
      without authentication.
- [ ] Download every public asset anew, verify `SHA256SUMS`, extract it, and run
      the source-archive verification/build checks from section 3.
- [ ] Verify the source archive corresponds to the tagged tree and contains no
      untracked local file.
- [ ] Confirm GitHub displays both workflows green for the released commit and
      branch protection/rulesets are active.
- [ ] Confirm Issues and Discussions show the intended templates/contact path,
      or remain disabled intentionally.
- [ ] Confirm private vulnerability reporting remains enabled after the
      visibility change and a security maintainer can still access it.
- [ ] Build the VS Code extension from its downloaded source archive in a clean
      profile and verify `.nmt` highlighting, LSP startup, preview, package
      inspection, and complete verification with explicitly configured tools.
- [ ] Build the JetBrains source archive only on a declared compatible IDE/JDK
      baseline and label commercial-LSP/source limitations exactly as documented.
- [ ] If the Studio/landing page is deployed separately, verify HTTPS, PWA
      manifest/service-worker scope, offline reload, `.nmt`/`.nmdoc` open/drop,
      download fallback, and mobile layout. A GitHub release does not itself
      prove a working web deployment.
- [ ] Test `notmarkdown git install --local` in a fresh public clone and confirm
      useful text diffs for both `.nmt` and `.nmdoc`.
- [ ] Verify all documentation still calls the media types proposals/drafts and
      does not claim IANA approval or OS-wide installation.

## 7. Failure and rollback rules

- [ ] Before public visibility: leave the repository private and release draft
      unpublished; fix forward on a new commit and rebuild everything.
- [ ] After public visibility but before release publication: stop, make the
      repository private if policy and GitHub permit, and investigate. Assume a
      public clone may already exist.
- [ ] If any credential was exposed: revoke/rotate it immediately before history
      cleanup, preserve an incident record, and do not rely on deleting a commit
      or release asset as remediation.
- [ ] If a published artifact is wrong but not malicious: do not retag or replace
      bytes silently. Publish a corrected version/tag and clearly mark the old
      release superseded or withdrawn.
- [ ] If a security-sensitive artifact is published: remove it from active
      download, use the private reporting/advisory process, publish checksummed
      fixed artifacts under a new version, and communicate impact precisely.

## 8. Release sign-off

Complete this record before the public-visibility command:

```text
Repository owner/name:
Release commit SHA:
Release tag + tag object SHA:
Format / Compatibility Kit / component versions:
License decision and reviewer:
Security contact tested by / timestamp:
Private vulnerability reporting verified by:
Local verification OS/toolchain:
Private CI run URLs:
Repeat-build checksum evidence:
Draft release URL:
Public visibility approved by:
Publication timestamp (with timezone):
Post-publication smoke owner/result:
Known limitations explicitly disclosed:
```
