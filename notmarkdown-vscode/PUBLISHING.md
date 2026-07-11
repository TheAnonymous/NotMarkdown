# VS Code Marketplace handoff

The extension manifest contains the stable user-facing repository, issue,
homepage, icon, and gallery metadata. The publisher id is provisionally
`notmarkdown`; it must exist in the Visual Studio Marketplace before
publication.

Build and inspect the installable archive:

```sh
npm ci
npm run check
npm run package
npx vsce ls --tree
```

Install the generated VSIX locally on Windows, macOS, and Linux. Verify `.nmt`
activation, the `.nmdoc` custom editor, untrusted-workspace behavior, LSP path
settings, and all three commands before uploading it.

Register the publisher, store a narrowly scoped Marketplace token as
`VSCE_PAT`, and publish the already-tested VSIX:

```sh
npx vsce publish --packagePath notmarkdown-vscode-0.2.0.vsix
```

Marketplace publication is a separate, credentialed operation. The GitHub
release workflow only builds the VSIX and never reads `VSCE_PAT`.
