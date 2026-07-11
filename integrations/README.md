# Platform integration

This directory contains inert, reviewable integration material that can be
packaged without changing the document format.

- `mime/` — proposed media types, deterministic identification, and IANA draft;
- `linux/` — shared MIME/desktop packaging scaffold;
- `icons/` — source artwork for generated platform icon sizes.

Studio 0.6.2 separately declares progressive `.nmdoc`/`.nmt` file handlers and
a local Web Share Target in its relative web app manifest. Those browser APIs
only apply to installed PWAs on supporting browser/operating-system pairs; they
do not replace these native packaging declarations. Picker, drag/drop, native
save where available, and download remain the portable browser fallbacks.

Windows ProgID/MSIX declarations, macOS UTType/Quick Look declarations, and
native preview/indexing components belong here once the desktop application
bundle identifiers and signing identities are fixed. No platform integration
may weaken parser/container resource limits or execute document content.

Everything in this directory is source scaffolding. Nothing here claims an
installed OS association, a signed application identity, or an approved media
type registration.
