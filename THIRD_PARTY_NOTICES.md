# Third-party notices

The NotMarkdown source distribution depends on, but does not relicense, the
following third-party projects. Their complete license texts ship with their
respective packages and remain controlling.

| Project | Pinned version | License | Use |
| --- | ---: | --- | --- |
| Mermaid | 11.16.0 | MIT | Static declarative diagram rendering in Studio |
| Vega | 6.2.0 | BSD-3-Clause | Static chart runtime in Studio |
| Vega-Lite | 6.4.3 | BSD-3-Clause | Declarative chart compilation in Studio |
| DOMPurify | 3.4.11 | Apache-2.0 or MPL-2.0 | Sanitization boundary for generated SVG |

NotMarkdown interoperates with the draw.io/diagrams.net file format, but does
not bundle the diagrams.net application, its stencil libraries, icons, or
other project assets. Compatibility with a format does not import that
project's Apache-2.0-licensed source into NotMarkdown.

This inventory covers the direct runtime libraries introduced for static
visuals. A public release still requires a complete dependency and bundled-
asset audit, including transitive packages and generated distributions.
