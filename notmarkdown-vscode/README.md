# NotMarkdown for Visual Studio Code 0.2

Early adoption plugin for `.nmt` source and `.nmdoc` packages. Version 0.2
adds exact static-visual highlighting and snippets for Mermaid, Vega-Lite,
and draw.io-backed diagram directives.

- TextMate highlighting and language configuration for familiar source editing;
- shared `notmarkdown-lsp` diagnostics, outline, hover, and completion;
- semantic source preview generated from canonical CDM JSON;
- read-only Package editor backed by `notmarkdown inspect`;
- explicit complete-package verification through `notmarkdown verify`;
- no network access, execution, macros, or arbitrary document HTML.

The preview remains script-free. Mermaid and Vega-Lite fences appear as
escaped, labelled source cards; sanitized offline rendering belongs to
NotMarkdown Studio. Package references use the CDM `resource`, `source`, and
`data` fields rather than editor-specific shortcuts.

Set `notmarkdown.server.path` and `notmarkdown.tool.path` when the binaries are
not on `PATH`. The extension does not start local processes in an untrusted
workspace.

```sh
npm install
npm run check
```

The next plugin slice will bundle signed per-platform binaries and reuse the
Studio Document/Package components for a full three-view custom editor.
