# Package-manager templates

These files are release-input templates, not published package records. The
release workflow replaces every `@TOKEN@` from final, checksummed GitHub
release assets and uploads the rendered manifests next to the binaries.

Supported templates:

- Homebrew formula for macOS and Linux, x64 and arm64;
- Scoop manifest for Windows x64 and arm64;
- WinGet version/default-locale/installer manifests;
- AUR `PKGBUILD` for Linux x86_64 and aarch64.

Render locally after all six native archives exist:

```sh
python3 -B release/scripts/render_distribution.py \
  --artifacts-dir <release-assets> \
  --templates-dir integrations/package-managers/templates \
  --output-dir <rendered-output> \
  --repository <owner/repository> \
  --version 0.12.0 \
  --tag compatibility-kit-v0.2.0
```

Rendered files still need review and submission to their respective package
repositories. Homebrew taps and Scoop buckets may use them directly; the
official Homebrew Core, WinGet, and AUR repositories each have their own
review/ownership process. Release automation does not submit or publish them.

