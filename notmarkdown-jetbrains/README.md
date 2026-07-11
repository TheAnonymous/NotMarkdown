# NotMarkdown for JetBrains IDEs 0.1

Initial thin-client plugin scaffold for IntelliJ-platform IDEs.

- `.nmt` and `.nmdoc` file types;
- shared `notmarkdown-lsp` diagnostics, completion, hover, and structure;
- background `inspect` and complete `verify` actions;
- configurable binaries through `NOTMARKDOWN_LSP` and `NOTMARKDOWN_TOOL`;
- no document execution and no network dependency.

The current LSP module targets IntelliJ Platform 2026.1 commercial IDEs. The
official JetBrains LSP API is not available in open-source IntelliJ builds or
Android Studio, so broad adoption requires a second baseline module using
native IntelliJ language APIs while keeping the Rust server as the semantic
authority. That split is deliberate and documented in the adoption plan.

Build with a local Gradle installation:

```sh
gradle buildPlugin
gradle verifyPlugin
```

The generated distribution appears under `build/distributions/`.
