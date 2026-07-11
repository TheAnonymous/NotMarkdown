# Maintainer setup that cannot live in source control

The repository keeps builds reproducible and permissions minimal, but several
GitHub and marketplace controls require an authenticated owner to enable them.

## GitHub repository controls

1. Enable **Private vulnerability reporting** under Settings → Security →
   Code security and analysis. Verify that the form linked from `SECURITY.md`
   is visible from a logged-out or non-owner account.
2. Protect `main` with pull requests and required status checks after the first
   green run. Require the Linux, macOS, and Windows Node/Rust checks, dependency
   audits, and Pages build. Do not require a status name that has never run.
3. Require conversation resolution, block force pushes and deletions, and keep
   the repository owner's emergency bypass explicit and audited.
4. Enable Dependabot alerts and security updates. The update schedule itself is
   defined in `.github/dependabot.yml`.
5. Keep the `github-pages` environment restricted to `main`.

## Signing and publisher credentials

Unsigned release candidates can be built without secrets. Public marketplace
or signed desktop publication needs narrowly scoped repository secrets owned
by the maintainer:

- `VSCE_PAT` for the Visual Studio Marketplace publisher;
- `OVSX_PAT` for Open VSX;
- `JETBRAINS_PUBLISH_TOKEN` for JetBrains Marketplace;
- platform-specific Apple Developer ID/notarization, Windows code-signing, and
  Linux repository signing credentials;
- Tauri updater signing material if automatic desktop updates are enabled.

Never make a release workflow echo, archive, or upload signing keys. Use
protected environments with approval for marketplace and signing jobs.

## Package-manager submissions

Homebrew, WinGet, Scoop, and AUR definitions are generated from an immutable
GitHub release and its `SHA256SUMS`. Their upstream submissions happen only
after every referenced release URL is public and its checksum has been
verified from a clean download.
