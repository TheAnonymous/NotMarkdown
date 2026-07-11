# NotMarkdown Desktop scaffold

This is the native shell for the existing Studio build, not a second editor.
It uses Tauri 2 so the same Document, Source, and Package views can eventually
ship on Windows, macOS, and Linux with a small native boundary.

The scaffold deliberately has no filesystem, shell, network, updater, or
process-spawning plugin permission. The bundled UI remains local and inert.
Native open/save dialogs, file associations, signing, automatic updates, and
embedded Rust binaries must be added as narrowly reviewed capabilities.

## Local development

Build Studio first, then start the wrapper:

```sh
npm --prefix ../../notmarkdown-web-editor ci
npm --prefix ../../notmarkdown-web-editor run build
npm ci
npm run desktop:dev
```

Create an unsigned development build with `npm run desktop:build`. Bundling is
disabled in `tauri.conf.json`; enabling installers is a release decision that
requires stable bundle identifiers, icons, per-platform signing identities,
and update-key custody. This scaffold is therefore not included among the
current GitHub release binaries.

Before the first desktop release:

1. pin and commit the resolved Cargo lockfile;
2. expose only explicit file-open/save capabilities for `.nmt` and `.nmdoc`;
3. sidecar the matching `notmarkdown`/`notmarkdown-lsp` binaries per target;
4. run the Studio suite inside each platform webview;
5. define Windows Authenticode, Apple notarization, and Linux package signing;
6. enable bundle targets and test install, upgrade, rollback, and uninstall.

