# NotMarkdown 0.1 — Design and Format Draft

Status: exploratory specification draft  
Date: 2026-07-10  

Normative companion drafts:

- notmarkdown-cdm-0.1.schema.json — machine-readable Canonical Document Model
- notmarkdown-source-0.1.ebnf — deterministic source grammar and constraints
- notmarkdown-manifest-0.1.schema.json — machine-readable package manifest

Reference implementation:

- notmarkdown-reference-toolchain 0.5 — TypeScript parser, deterministic
  packer, incremental search cache, CLI, diagnostics, and conformance tests
- notmarkdown-web-editor 0.6 — local-first browser editor with synchronized
  views, range-based package opening, deterministic streaming writes, lazy
  verified assets, automatic outline, cached search, and generated contents
- notmarkdown-rust 0.10 — canonical CDM JSON, metadata-first package opening,
  verified-on-access representations, deterministic package creation, shared
  language server, semantic CLI, and terminal editor

Editor architecture companion:

- NotMarkdown-Editor-Architecture-0.1.md — implemented browser slice and the
  terminal/desktop roadmap
- NotMarkdown-Adoption-Plan-0.1.md — IDE integration architecture, landing-page
  prototype, and adoption sequence

Working file extensions: `.nmdoc` (packaged document), `.nmt` (text source)

## 1. Purpose

NotMarkdown is an open, portable, single-file format for static, media-rich
documents. It keeps the low-friction authoring experience of Markdown while
removing dialect ambiguity, external asset folders, optional core features,
and unrestricted presentation.

The format is intended for technical documentation, articles, reports, notes,
READMEs, research-oriented writing, and project documentation.

NotMarkdown is intentionally not:

- a presentation format;
- an executable notebook;
- a web application format;
- an interactive form format;
- a free-form page-layout system;
- a container for automatically executed scripts.

## 2. Design principles

### 2.1 Familiar by default

Common Markdown constructs retain their familiar spelling wherever that does
not introduce ambiguity. Headings, paragraphs, emphasis, links, quotations,
code, and lists should not require experienced Markdown authors to relearn
basic writing.

### 2.2 One meaning

Every conforming parser must produce the same abstract document tree for the
same source. Implementations must not guess, silently reinterpret invalid
syntax, or use implementation-defined parsing rules.

### 2.3 Semantic, constrained presentation

Authors describe meaning: heading, warning, quotation, source code, figure,
or caption. Renderers control typography, spacing, colors, and responsive
layout through versioned themes.

The core format does not permit arbitrary CSS, fonts, font sizes, text colors,
absolute positioning, floating text boxes, or executable HTML.

### 2.4 Complete documents

A packaged document may contain its images, audio, video, diagrams, captions,
transcripts, and ordinary attachments. It must remain usable offline unless an
external resource was explicitly chosen by the author.

### 2.5 Durable but modern

The document grammar, package format, theme profile, and media profile have
independent versions. New compression algorithms and media codecs therefore
do not require a new text language.

### 2.6 Safe by construction

Opening and rendering a document must not execute embedded code, contact the
network, or load external resources without an explicit user action.

## 3. Conformance language

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative requirements
in the sense commonly used by Internet standards.

Conformance has four separately testable roles:

- **Source parser:** converts `.nmt` source into the canonical document model.
- **Package reader:** reads `.nmdoc` containers and validates their manifest.
- **Renderer:** presents the canonical document model.
- **Editor:** modifies a document without corrupting or silently discarding it.

An implementation MUST state which roles and format versions it supports.

## 4. Document forms

### 4.1 Packaged form

`.nmdoc` is the normal form for saving and sharing. It is one file containing
the source and all embedded resources.

The logical package structure is:

```text
mimetype
manifest.json
document.nmt
assets/
diagrams/
previews/
```

Only `mimetype`, `manifest.json`, and `document.nmt` are required.

### 4.2 Text form

`.nmt` is UTF-8 source text. It is the authoritative representation of document
content and can be opened in an ordinary text editor.

An unpacked `.nmt` document MAY refer to external local files for authoring.
Packing it into `.nmdoc` embeds those files by default.

### 4.3 Authority

Generated SVG diagrams, thumbnails, waveforms, and PDF previews are caches.
When cached output conflicts with its source, the source is authoritative.

## 5. Source header

A standalone NotMarkdown source begins with:

```text
@notmarkdown 0.1
```

The header MUST be the first non-BOM content in the file. A UTF-8 BOM SHOULD
NOT be written but MUST be accepted.

Document metadata follows in one optional directive:

```text
@document {
  title: "Energy Systems"
  language: en
  theme: standard
  accent: violet
  density: comfortable
}
```

Unknown required header fields are errors. Unknown optional metadata fields
must be preserved by editors.

## 6. Familiar core syntax

Version 0.1 retains these Markdown-like constructs:

```text
# Heading level 1
## Heading level 2

A paragraph with **strong importance**, *emphasis*, and `inline code`.

[A link](https://example.org)

> A quotation

- An unordered item
- Another item

1. A first ordered item
1. A second ordered item

---
```

### 6.1 Ordered lists

Authors SHOULD write `1.` for every ordered item. Renderers calculate displayed
numbers from list structure. Editors MUST NOT require manual renumbering.

An explicit start value is written as an attribute on the first item:

```text
4.{start} Fourth item
1. Fifth item
```

The exact compact spelling of non-default list starts remains provisional for
0.1 and is not yet normative.

### 6.2 Line endings and paragraphs

LF and CRLF are accepted and normalized to LF in the document model. A single
line ending inside a paragraph is semantically a space. A blank line ends the
paragraph.

A forced line break uses a backslash immediately before the line ending:

```text
First line\
Second line
```

Trailing spaces never create structural meaning.

### 6.3 Raw HTML

Raw HTML is not part of the core grammar. Importers may convert safe HTML into
NotMarkdown nodes. They must preserve unsupported source visibly rather than
executing it.

## 7. Directives

Features that Markdown does not express consistently use directives. Directive
names are lowercase ASCII and their grammar is shared by all block types.

### 7.1 Short directives

```text
!note[The operation can take several minutes.]

!warning[Existing data will be replaced.]
```

### 7.2 Resource directives

```text
![A Norwegian fjord](asset:fjord)

!audio[Interview with Ada](asset:ada-interview)

!video[Prototype demonstration](asset:prototype-demo)
```

The existing Markdown image form remains the short spelling for `!image`.

### 7.3 Attributes

Simple attributes may follow a construct:

```text
![A Norwegian fjord](asset:fjord){layout=wide}
```

Complex attributes use a block:

```text
!video[Prototype demonstration](asset:prototype-demo) {
  poster: asset:prototype-poster
  captions.de: asset:prototype-captions-de
  captions.en: asset:prototype-captions-en
  transcript: asset:prototype-transcript
  start: 00:00:12
}
```

Compact and block attributes map to the same typed attribute object. Duplicate
attributes are errors. Attribute order has no semantic meaning.

### 7.4 Automatic navigation, contents, and search

Every conforming editor SHOULD expose an outline derived from heading nodes
without requiring author-maintained navigation markup. Outline entries contain
the heading level, semantic text, optional explicit ID, and a CDM JSON Pointer
to the heading occurrence. Generated occurrence paths support local navigation;
only explicit source IDs are stable external link targets.

A visible table of contents is placed with:

```text
!toc
```

An optional maximum heading depth is written as:

```text
!toc{depth=3}
```

The canonical `tableOfContents` node stores only placement and the optional
depth. Its entries MUST be derived from the complete current heading outline
and MUST NOT be copied into authoritative source or CDM as manually maintained
text. Renderers with no headings show an empty, accessible contents fallback.

Editors SHOULD also derive a local full-text index from canonical text,
headings, lists, code, footnotes, mathematical source, media labels and
alternative text, attachment labels, and fallback asset identifiers. Search
MUST NOT fetch external resources. Index data is a disposable cache: deleting,
omitting, or rebuilding it cannot change document meaning, and readers MUST
ignore an index whose declared model or source hash is stale.

The initial deterministic search profile normalizes semantic whitespace,
matches all case-folded query terms, ranks headings and media labels above
ordinary text, and breaks equal scores by CDM path. Implementations may provide
additional presentation ranking, but conformance APIs use the deterministic
profile.

Search-index profile 0.2 extends that same disposable index to verified,
embedded textual asset representations. It recognizes UTF-8 `text/plain`,
`text/markdown`, `text/vtt`, `text/csv`, `text/tab-separated-values`,
`application/json`, `application/yaml`, `application/xml`, and
`application/x-subrip`. Binary media, PDFs, HTML, CSS, scripts, and unknown
types are not decoded or searched. Search never extracts text from an external
URI.

Each indexed asset entry records its logical asset ID, media type, internal
package path, and semantic relationship such as `captions`, `transcript`,
`chapters`, `attachment`, `source`, or `data`. It is anchored to the first
reading-order CDM block that references that logical asset. Selecting the hit
therefore navigates to meaningful document context instead of exposing a ZIP
path as document structure. Asset text ranks below headings and media labels
but above ordinary document text; equal scores break by CDM path, asset ID, and
package path.

WebVTT indexing removes the `WEBVTT` header, cue identifiers, timestamps,
`NOTE`, `STYLE`, and `REGION` blocks, and inline cue tags before whitespace
normalization. Other recognized text types use their decoded text directly.
Invalid UTF-8 and representations exceeding the search limits are omitted and
reported in the derived index; they do not make document meaning depend on
search support.

The default conformance limits are 8 MiB per textual representation and 64 MiB
across all textual representations in one indexing operation. Implementations
MAY expose lower configurable limits, but MUST report every size-based omission
and MUST process assets in logical-ID then package-path order. The package-wide
index remains a cache and MUST NOT be stored as authoritative document content.

#### 7.4.1 Incremental session cache

Editors SHOULD retain normalized asset text and the document-only index in a
bounded, in-memory session cache. A document-index hit requires exact equality
with the editor's current authoritative source fingerprint. An asset-text hit
requires the logical asset ID, package path, media type, and verified manifest
SHA-256 to match. A cache entry never substitutes for opening and verifying the
package containing it.

Changing document structure invalidates the document-only index but does not
require unchanged assets to be decoded again. Their cached text is re-anchored
to the first current semantic reference so heading, section, role, and path
changes remain visible. Changing one representation fingerprint invalidates
only that representation. Removed, unsupported, over-limit, or unreferenced
representations MUST be pruned from the active cache.

The 8 MiB per-representation and 64 MiB total limits are reapplied on every
update before cache lookup. Invalid-UTF-8 omissions may themselves be cached by
fingerprint so repeated searches do not repeatedly decode the same invalid
bytes. Cache generation counters and reuse/rebuild statistics are informative
editor telemetry and MUST NOT affect result ordering or conformance output.

An optional persisted generated cache MAY use the same keys, but it is never
authoritative, MUST be ignored after any source/media-type/hash mismatch, and
MUST be safe to delete without changing document meaning. The 0.1 container
does not yet define a canonical on-disk cache entry.

### 7.5 Unknown directives

Unknown unqualified directives are errors. Extension directives must use a
namespace:

```text
!org.example.component[Readable fallback text] {
  option: value
}
```

Every extension directive MUST contain or declare a text fallback. Editors
that do not understand an extension MUST preserve it byte-for-byte where
possible and MUST expose the fallback.

## 8. Media

### 8.1 References

Resources use explicit URI schemes:

- `asset:id` — embedded and available offline;
- `https://...` — external and never fetched automatically;
- `file:...` — authoring-only local reference, forbidden in a packed document.

Bare relative paths are permitted in unpacked authoring form but MUST be
resolved or rejected during packaging.

### 8.2 Images

Images require alternative text. Empty alternative text is permitted only when
the image is explicitly decorative:

```text
![](asset:divider){decorative=true}
```

Permitted layout intentions are:

- `inline`
- `normal` (default)
- `wide`
- `full`
- `gallery`

Pixel dimensions, arbitrary margins, and absolute positions are not authoring
features.

### 8.3 Audio

Audio is a first-class block. It may include a transcript, chapters, cover art,
and multiple representations. Renderers MUST NOT autoplay it.

### 8.4 Video

Video is a first-class block. It may include a poster, captions, transcript,
chapters, and multiple audio tracks. Renderers MUST NOT autoplay it.

### 8.5 Multiple representations

One logical asset may have multiple encoded representations. The manifest
identifies their media types, codecs, roles, sizes, and integrity hashes.

Roles include:

- `playback` — optimized for ordinary rendering;
- `original` — optional author-supplied original;
- `fallback` — broadly compatible alternative;
- `poster`, `thumbnail`, or `waveform` — generated presentation caches.

Editors SHOULD offer these import policies:

- optimize;
- optimize and preserve original;
- preserve unchanged.

### 8.6 Media profiles

Codec recommendations belong to a separately versioned media profile. A
profile declares required decoding baselines and preferred encodings. Profiles
may evolve without changing source syntax.

The initial profile is expected to consider modern formats such as AVIF or
JPEG XL for photographic images, SVG for vector graphics, Opus for audio, AV1
for video, and WebVTT for timed text. This list is informative until the media
profile is specified and tested.

## 9. Built-in document components

The following components are core capabilities rather than optional plugins:

- headings and sections;
- ordered, unordered, and task lists;
- quotations and citations;
- fenced code blocks;
- tables;
- figures and galleries;
- audio and video;
- footnotes and cross-references;
- mathematical notation;
- callouts such as note, tip, warning, and danger;
- flow, sequence, and architecture diagrams;
- common categorical, trend, composition, and relationship charts;
- ordinary file attachments.

The exact table, formula, citation, diagram, and chart grammars remain to be
specified. They MUST be declarative and MUST NOT execute arbitrary code.

## 10. Canonical document model

The Canonical Document Model (CDM) is the normative semantic result of parsing
NotMarkdown source. Two conforming parsers given the same valid source MUST
produce equivalent CDM trees.

The CDM is not the authoring syntax and is not stored as the authoritative
document. Its JSON representation exists for conformance testing, semantic
diffs, transformations, accessibility, and renderer interoperability.

### 10.1 Model version

Every canonical tree begins with a model version independent from the source
and package versions:

~~~json
{
  "type": "document",
  "modelVersion": "0.1",
  "metadata": {},
  "children": []
}
~~~

An implementation MUST NOT emit a model version that it cannot validate.

### 10.2 Node categories

Nodes belong to one of four categories:

- **root** — the document node;
- **block** — paragraphs, sections, lists, media, tables, and similar objects;
- **inline** — text, emphasis, links, code spans, and references;
- **definition** — footnote, citation, asset, and extension definitions.

The category is determined by the node type and is not repeated in canonical
JSON.

Block nodes cannot appear inside inline children. Inline nodes cannot appear
directly as children of the document root. Definitions live in the root
definitions map and do not appear in reading order unless explicitly rendered
through a reference.

### 10.3 Common node shape

Every node has a type. Depending on its type, it may also have:

- children — an ordered array of child nodes;
- attributes — typed semantic attributes;
- id — an author-declared stable identifier;
- text — Unicode text for a text-bearing leaf;
- target — a typed internal or external reference.

Fields not defined for a node type are forbidden. Canonical JSON does not use
null for absent optional fields.

Source offsets, line numbers, editor selections, parse warnings, cached layout,
and generated database identifiers are not semantic node fields. Tools may
carry them in a separate side table keyed by node occurrence.

### 10.4 Root node

The root node has this logical form:

~~~json
{
  "type": "document",
  "modelVersion": "0.1",
  "metadata": {
    "title": "Example",
    "language": "en",
    "theme": "standard",
    "accent": "violet",
    "density": "comfortable"
  },
  "children": [],
  "definitions": {
    "footnotes": {},
    "citations": {},
    "extensions": {}
  }
}
~~~

Metadata keys defined by the core specification have typed values. Namespaced
extension metadata may be preserved but cannot alter core parsing semantics.

### 10.5 Block nodes

The initial CDM defines these block types:

| Type | Required fields | Permitted children |
| --- | --- | --- |
| paragraph | children | inline |
| heading | level, children | inline |
| thematicBreak | none | none |
| tableOfContents | none; optional maxDepth | none; entries are derived |
| blockQuote | children | block |
| list | ordered, children | listItem |
| listItem | children | block |
| codeBlock | text | none |
| table | columns, children | tableRow |
| tableRow | kind, children | tableCell |
| tableCell | children | block |
| callout | kind, children | block |
| figure | resource, alt | caption blocks |
| audio | resource, label | caption blocks |
| video | resource, label | caption blocks |
| gallery | children | figure, audio, or video |
| diagram | diagramType, source | caption blocks |
| chart | chartType, data | caption blocks |
| mathBlock | source, notation | none |
| attachment | resource, label | caption blocks |
| extensionBlock | name, fallback | extension-defined |

A heading level is an integer from 1 through 6. Heading hierarchy is semantic;
renderers must not choose levels based on desired font size.

A list node has ordered set to true or false. An ordered list may have a
positive start value; omitted start means 1. Displayed item numbers are derived
and never stored on individual list items.

A task-list item uses the optional checked attribute with true or false. This
attribute represents static state and is not an interactive control.

### 10.6 Inline nodes

The initial CDM defines these inline types:

| Type | Required fields | Permitted children |
| --- | --- | --- |
| text | text | none |
| emphasis | children | inline |
| strong | children | inline |
| code | text | none |
| link | target, children | inline |
| image | resource, alt | none |
| hardBreak | none | none |
| softBreak | none | none |
| footnoteReference | target | none |
| citationReference | targets | none |
| crossReference | target, children | inline |
| mathInline | source, notation | none |
| extensionInline | name, fallback | extension-defined |

Ordinary source line endings inside a paragraph produce softBreak nodes only
when source-preserving tooling requests them. The normalized semantic CDM
replaces soft breaks with a single space in adjacent text unless a profile
explicitly requires source-line preservation. Hard breaks remain nodes.

### 10.7 Text normalization

Canonical text obeys these rules:

1. Text is valid Unicode and serialized as UTF-8.
2. Parsers MUST NOT silently replace invalid byte sequences.
3. Unicode normalization forms are not changed by parsing.
4. Adjacent text nodes with identical semantics are merged.
5. Empty text nodes are removed.
6. Source line endings are normalized according to paragraph rules.
7. Entity spellings and escape spellings are decoded to their represented
   Unicode characters.

Not normalizing Unicode avoids silently changing names, identifiers, quoted
source, or code. Tools may diagnose visually confusable identifiers.

### 10.8 Identifiers

Author-declared identifiers are optional except where another node references
them. They use this form in source:

~~~text
## Results {#results}
~~~

An identifier:

- is unique within one document;
- is case-sensitive;
- begins with an ASCII letter;
- continues with ASCII letters, digits, hyphen, underscore, or period;
- is preserved across ordinary edits and repacking.

Renderers may generate convenience anchors for headings without explicit IDs,
but generated anchors are not canonical and cannot be reliable cross-reference
targets.

Asset IDs occupy a separate namespace from node IDs. Footnote and citation IDs
also have separate namespaces. Ambiguity within any one namespace is an error.

### 10.9 References

References are typed rather than stored as undifferentiated strings:

~~~json
{
  "kind": "internal",
  "id": "results"
}
~~~

~~~json
{
  "kind": "asset",
  "id": "fjord"
}
~~~

~~~json
{
  "kind": "external",
  "uri": "https://example.org"
}
~~~

Internal references MUST resolve before a packaged document is considered
valid. External references are syntax-validated but are never contacted during
parsing or validation.

### 10.10 Media nodes

Media nodes reference logical asset IDs, never internal package paths.

An image occurring among other inline content becomes an image inline node.
An image that is the sole meaningful content of a paragraph is promoted to a
figure block. A caption or block-level layout attribute also forces figure
interpretation. This promotion rule is syntactic and therefore cannot vary by
renderer.

~~~json
{
  "type": "video",
  "resource": {
    "kind": "asset",
    "id": "prototype-demo"
  },
  "label": [
    {
      "type": "text",
      "text": "Prototype demonstration"
    }
  ],
  "attributes": {
    "layout": "normal",
    "poster": {
      "kind": "asset",
      "id": "prototype-poster"
    },
    "captions": {
      "de": {
        "kind": "asset",
        "id": "prototype-captions-de"
      }
    }
  },
  "children": []
}
~~~

Playback state, volume, current position, and whether a user has watched or
listened are never document semantics.

### 10.11 Extension nodes

Extension nodes have a globally namespaced name, a required fallback, and an
extension value whose shape is controlled by that namespace:

~~~json
{
  "type": "extensionBlock",
  "name": "org.example.component",
  "fallback": [
    {
      "type": "paragraph",
      "children": [
        {
          "type": "text",
          "text": "Readable fallback"
        }
      ]
    }
  ],
  "value": {}
}
~~~

Unknown extensions cannot change how surrounding core nodes are parsed. A
renderer that does not support an extension renders its fallback. An editor
must preserve the extension value when performing unrelated edits.

### 10.12 Canonical normalization

Before conformance comparison or semantic hashing, a tree is normalized:

1. Optional fields with their defined default values are omitted.
2. Object keys are emitted in the order prescribed by the CDM schema.
3. Map keys are sorted by Unicode code point.
4. Adjacent text nodes are merged and empty text nodes removed.
5. Derived values such as displayed list numbers are omitted.
6. Source locations, diagnostics, caches, and editor state are omitted.
7. Numbers use their shortest lossless JSON spelling.
8. JSON strings use the minimum required escaping.

Array order is always significant. Object key order has no semantic meaning
even though canonical serialization prescribes one.

### 10.13 Parsing failure and recovery

A conforming parser returns either:

- a valid canonical tree and zero fatal diagnostics; or
- no canonical tree and one or more fatal diagnostics.

Editors may construct partial recovery trees for display, but those trees are
not conforming CDM documents and must not be packaged without resolving the
errors.

Diagnostics contain a stable error code, human-readable message, source range,
and optional repair suggestion. The wording may vary; the error code may not.

### 10.14 Round trips

Semantic round-trip stability is required:

~~~text
parse(serialize(parse(source))) == parse(source)
~~~

Byte-for-byte source preservation is not generally required. It is required
for unknown extension payloads when an editor makes no change within that
payload.

Canonical serializers should produce simple, familiar source rather than
preserving unusual but equivalent spelling.

### 10.15 Source-to-CDM example

Source:

~~~text
@notmarkdown 0.1

# Results {#results}

The result is **important**.

1. First observation
1. Second observation

![A fjord](asset:fjord){layout=wide}
~~~

Normalized CDM excerpt:

~~~json
{
  "type": "document",
  "modelVersion": "0.1",
  "metadata": {},
  "children": [
    {
      "type": "heading",
      "level": 1,
      "id": "results",
      "children": [
        {
          "type": "text",
          "text": "Results"
        }
      ]
    },
    {
      "type": "paragraph",
      "children": [
        {
          "type": "text",
          "text": "The result is "
        },
        {
          "type": "strong",
          "children": [
            {
              "type": "text",
              "text": "important"
            }
          ]
        },
        {
          "type": "text",
          "text": "."
        }
      ]
    },
    {
      "type": "list",
      "ordered": true,
      "children": [
        {
          "type": "listItem",
          "children": [
            {
              "type": "paragraph",
              "children": [
                {
                  "type": "text",
                  "text": "First observation"
                }
              ]
            }
          ]
        },
        {
          "type": "listItem",
          "children": [
            {
              "type": "paragraph",
              "children": [
                {
                  "type": "text",
                  "text": "Second observation"
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "type": "figure",
      "resource": {
        "kind": "asset",
        "id": "fjord"
      },
      "alt": "A fjord",
      "attributes": {
        "layout": "wide"
      },
      "children": []
    }
  ],
  "definitions": {
    "footnotes": {},
    "citations": {},
    "extensions": {}
  }
}
~~~

### 10.16 Initial CDM conformance fixtures

The reference suite must include at least:

- every node type in isolation;
- every permitted nesting relationship;
- forbidden nesting cases;
- adjacent emphasis and text normalization;
- ordered lists with insertion and non-default starts;
- duplicate and unresolved IDs;
- asset, footnote, citation, and node namespace separation;
- malformed UTF-8 and invalid escapes;
- unknown core directives and preserved extension directives;
- media with multiple caption languages;
- canonical serialization and semantic round trips;
- deeply nested input and resource-limit behavior.

## 11. Presentation model

### 11.1 Semantic formatting only

Source expresses role and intent. It does not set arbitrary visual properties.

Allowed author-controlled presentation hints are deliberately small:

- a standardized theme;
- a standardized accent family;
- compact or comfortable density;
- semantic media layout intent;
- semantic table alignment, such as numeric or textual content.

### 11.2 Themes

Themes are versioned, named design systems. A theme controls typography,
spacing, color mapping, callout appearance, media players, diagrams, print,
light mode, and dark mode.

A document may select a standard theme but cannot modify individual theme
rules. Theme profile `0.1` defines these document-bound values:

- `standard`
- `paper`
- `technical`
- `minimal`
- `sepia`
- `midnight`
- `high-contrast`

Theme names and their visual contracts remain provisional.
Consequently, this extension does not change the provisional theme profile
identifier from `0.1`. Documents using the original values need no migration;
implementations built against an earlier strict `0.1` snapshot may reject only
documents that select one of the added values.

### 11.3 Rendering freedom

Renderers may adapt layout to screen size, accessibility settings, or print.
They must preserve structure, content order, relationships, numbering, and
resource identity.

## 12. Package manifest

The package manifest is normatively defined by
notmarkdown-manifest-0.1.schema.json. It contains:

- the package, theme, media, and container-profile versions;
- the authoritative source path and its SHA-256 hash;
- every logical asset ID;
- every stored representation, role, media type, byte length, and SHA-256 hash.

Asset IDs are stable logical identifiers. Source never depends on internal file
names. Every stored representation MUST declare its exact byte length and
cryptographic integrity hash.

Paths are UTF-8, relative, slash-separated, normalized, and unique. Absolute
paths, backslashes, empty segments, dot segments, and parent segments are
fatal errors.

Readers MUST reject missing entries, undeclared entries, duplicate asset IDs,
duplicate paths, hash mismatches, and assets not referenced by the canonical
document.

## 13. Container and compression

### 13.1 Physical format

The 0.1 container is a constrained single-disk ZIP file. Entries appear in
this deterministic order:

1. mimetype
2. manifest.json
3. document.nmt
4. asset representations sorted by logical asset ID and representation role

The mimetype entry is first, uncompressed, and contains exactly:

    application/vnd.notmarkdown.document+zip

The 0.1 profile uses UTF-8 filenames, fixed 1980-01-01 timestamps, no archive
comment, no per-entry comments, no encryption, no data descriptors, no extra
fields, and no multi-disk features. ZIP64 is deferred.

### 13.2 Portable profile

portable-0.1 uses ZIP method 8 (Deflate) at the profile's fixed maximum level
for text and other generically compressible entries. Already-compressed images,
audio, video, PDFs, and opaque binary data use method 0 (store).

This profile is intended for extraction by conventional ZIP tools.

### 13.3 Modern profile

modern-0.1 uses ZIP method 93 (Zstandard) for text, JSON, SVG, timed text, and
other generically compressible entries. Already-compressed media uses method 0.

This is the default authoring profile. It requires a ZIP implementation with
method-93 support or a conforming NotMarkdown reader. Older ZIP utilities may
list the package but be unable to decompress its Zstandard members.

### 13.4 Integrity and resource limits

Every entry carries ZIP CRC-32. The manifest additionally carries SHA-256 for
the source and every asset representation. Both checks are mandatory.

Readers MUST enforce configurable limits for entry count, individual expanded
size, total expanded size, nesting-free path extraction, and compression ratio.
They MUST compare local and central ZIP headers before decompression and reject
unknown compression methods or flag bits.

Derived full-text indexing has separate, lower memory limits. The conformance
profile reads at most 8 MiB from one recognized textual representation and at
most 64 MiB across one package index. Implementations inspect declared media
types and sizes before allocating buffers and never decode binary media merely
to discover whether it contains text.

### 13.5 Progressive range opening

The 0.1 bytes do not require a streaming-specific container variant. A reader
MAY open a seekable file or browser `Blob` progressively by reading only:

1. the bounded ZIP end-record tail;
2. the central directory;
3. every referenced local header and filename;
4. `mimetype`, `manifest.json`, and `document.nmt`.

Before exposing source or package structure, the reader MUST apply the normal
entry-count, expanded-size, total-size, compression-ratio, path, compression,
flag, duplicate, declaration, and local/central-header checks. Manifest sizes
MUST agree with central-directory sizes before an asset can be listed.

Asset payloads MAY remain deferred. A deferred representation has three
observable validation states: `declared`, `loading`, and `verified`; a failed
load is `rejected`. It MUST NOT be described as verified, decoded, previewed,
indexed, extracted, or passed to a writer until the reader has:

1. read only that entry's compressed byte range;
2. decompressed it within the declared resource limits;
3. matched its expanded length and ZIP CRC-32;
4. matched its manifest SHA-256.

A reader may therefore expose a structurally validated package and verified
source before all asset hashes have been evaluated. “Package fully verified”
is reserved for a session in which every declared representation reached the
`verified` state. Repeated access SHOULD reuse verified bytes or an equivalent
verified backing store. Failed verification is sticky for that exact package
identity and representation hash.

Range opening does not relax the no-network rule, does not introduce external
asset references, and does not change deterministic package bytes. ZIP64 and
non-seekable input remain deferred.

### 13.6 Streaming package writing

The 0.1 profile forbids ZIP data descriptors, so CRC-32, expanded size, and
compressed size MUST be known when each local header is written. A streaming
writer therefore uses a preflight phase before emitting the first byte:

1. normalize and parse the source;
2. confirm that source references and supplied logical assets match exactly;
3. scan every representation through bounded chunks to establish expanded
   length, CRC-32, and manifest SHA-256;
4. construct the complete canonical manifest and deterministic entry plan.

After preflight, already-compressed media assigned method 0 MAY stream directly
to an abortable output sink. The writer MUST recompute length, CRC-32, and
SHA-256 during that second pass and abort the sink if the representation no
longer matches preflight. A conforming atomic sink MUST NOT publish partial
package bytes after abort.

Compressible members require their packed size before their local header.
Implementations without an incremental deterministic codec MAY buffer the
current member, but MUST NOT require the whole output archive or unrelated
media to be resident simultaneously. The bounded central directory may remain
in memory until all local members have been emitted.

The final local headers, payloads, central directory, and end record are the
same canonical ZIP32 bytes produced by a non-streaming writer. Streaming is an
I/O strategy, not a new container profile, and MUST NOT introduce data
descriptors, extra fields, alternate member order, or nondeterministic codec
parameters.

Browser implementations SHOULD use an atomic native file sink when available.
A compatibility download that materializes a final Blob is conforming but
SHOULD be identified as a memory-limited fallback rather than described as
streaming.

### 13.7 Determinism

Identical logical inputs, profile versions, compression parameters, and codec
implementations produce byte-identical packages. Manifests use recursively
sorted JSON keys and a single final line feed. Source line endings normalize to
LF and end in one line feed.

## 14. Determinism and version control

A canonical packer must produce byte-identical output for identical logical
input. Canonicalization includes normalized paths, member order, timestamps,
JSON serialization, text line endings, and compression parameters.

Official tools should provide:

```text
notmd pack document.nmt
notmd unpack document.nmdoc
notmd inspect document.nmdoc
notmd extract-source document.nmdoc
notmd diff old.nmdoc new.nmdoc
notmd optimize document.nmdoc
```

Semantic diff compares canonical document trees and asset hashes rather than
opaque container bytes.

## 15. Security and privacy

A conforming renderer:

- MUST NOT execute scripts or macros;
- MUST NOT autoplay audio or video;
- MUST NOT fetch external content without explicit consent;
- MUST prevent package paths from escaping the extraction directory;
- MUST enforce configurable decompression and resource limits;
- MUST validate declared sizes and integrity hashes;
- MUST treat active content in attachments as inert;
- MUST isolate declarative diagram and formula processing;
- MUST visibly distinguish external from embedded resources.

Editors SHOULD offer removal of location, camera, author, device, and other
private metadata when importing assets.

Digital signatures should be designed before 1.0 so that canonicalization does
not later invalidate the signature model. Encryption is outside 0.1.

## 16. Accessibility

The canonical model must preserve semantic heading order, lists, quotations,
tables, language changes, captions, alternative text, transcripts, timed text,
and link purpose.

Renderers must expose those semantics to platform accessibility APIs.

The format should make accessible authoring the path of least resistance:

- non-decorative images require alternative text;
- table headers are structural rather than visually inferred;
- audio and video support transcripts;
- video supports captions;
- color is never the only carrier of meaning;
- themes must meet defined contrast requirements.

## 17. Import and export

NotMarkdown does not claim that every Markdown dialect is valid NotMarkdown.
Importers must accept an explicit dialect where behavior differs:

```text
notmd import README.md --dialect github
```

Ambiguous or unsupported input produces diagnostics rather than silent guesses.

Exporters may target plain Markdown, HTML, PDF, or other formats. They must
report features that cannot be represented faithfully. Export does not change
the authoritative NotMarkdown source.

## 18. Example document

```text
@notmarkdown 0.1

@document {
  title: "Kvalsund Tidal Experiment"
  language: en
  theme: technical
  accent: blue
}

# Kvalsund Tidal Experiment

The experiment tested a tidal-stream generator in northern Norway.

!note[This example demonstrates syntax; its statements are not research claims.]

## Key observations

1. The project developed a prototype.
1. The prototype was installed.
1. Operational data was collected.

![Tidal generator near the seabed](asset:generator){layout=wide}

!video[Short installation overview](asset:installation) {
  poster: asset:installation-poster
  captions.en: asset:installation-captions-en
  transcript: asset:installation-transcript
}

## System relationship

!diagram[Prototype connection] {
  type: flow
  source: asset:system-diagram-source
}

> A static document may contain rich media without becoming an application.

## References

[^1]: Example reference entry.
```

## 19. Required work before 0.2

1. Expand the reference parser with the remaining conformance fixtures.
2. Resolve remaining directive and attribute edge cases through fixtures.
3. Specify tables, citations, formulae, diagrams, and charts in detail.
4. Define the first media and theme profiles.
5. Specify ZIP64 and streaming behavior for a later container profile.
6. Expand adversarial package fixtures across independent implementations.
7. Decide signature scope and canonical signing bytes.

## 20. Decisions deliberately deferred

- comments and tracked changes;
- digital-signature user experience;
- encryption;
- collaborative editing protocols;
- a standard annotation layer;
- long-term archival profiles.

These may be added without turning NotMarkdown into an interactive or
executable document platform.
