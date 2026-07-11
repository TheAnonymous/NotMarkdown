# NotMarkdown landing page 0.3

A polished, responsive, script-free product page with the real browser Studio
embedded as its primary product demonstration. Version 0.3 adds a polished
Mermaid, Vega-Lite, and draw.io story linked to a single-file showcase.

## Preview locally

Serve the repository root rather than this directory alone. The page expects
the sibling Studio production build at `notmarkdown-web-editor/dist/`:

```sh
python3 -m http.server 4175
```

Then open:

```text
http://127.0.0.1:4175/notmarkdown-site/index.html
```

## Product contract

- The first primary action scrolls to the live editor.
- The iframe loads the real Studio build with `?embed=1`; it is not a visual
  imitation of the product.
- Opening the top-level Studio remains available for the best native file-save
  picker behavior.
- The page itself contains no JavaScript, remote fonts, analytics, accounts, or
  uploads.
- Desktop and compact layouts must not introduce horizontal page or Studio
  overflow.
- Keyboard skip navigation, visible focus, and reduced-motion adaptation are
  required.

## Validate

```sh
npm run check
```

The check verifies the major sections, live Studio iframe, compact embed mode,
local asset paths, reduced-motion CSS, and keyboard skip navigation.
