# Draft media-type registration material

Status: preparation only; not submitted to IANA.

## Package type

- Type name: `application`
- Subtype name: `vnd.notmarkdown.document+zip`
- Required parameters: none
- Optional parameters: none
- Encoding considerations: binary
- File extension: `.nmdoc`
- Macintosh file type code: none assigned
- Intended usage: common
- Restrictions on usage: none beyond the security requirements below
- Author/change controller: to be assigned before submission
- Published specification: NotMarkdown format specification 0.1 or successor

### Magic and identification

A conforming package is a constrained ZIP file. Its first member is named
`mimetype`, is stored without compression or extra fields, and contains exactly
`application/vnd.notmarkdown.document+zip`. Readers must validate the complete
container contract rather than trusting filename or prefix alone.

### Interoperability

The package has deterministic member ordering, UTF-8 paths, a canonical
`document.nmt` authority, a canonical JSON manifest, fixed compression-profile
versions, and explicit representation media types and hashes. Generic ZIP
software may inspect portable-profile packages but is not a conforming
NotMarkdown reader.

### Security considerations

Readers process untrusted compressed archives and embedded media. They must
validate local and central ZIP headers, reject duplicate/unsafe paths,
unsupported flags, encryption, comments, extra fields, unknown compression
methods, and undeclared members. They must enforce entry-count, expanded-size,
total-size, compression-ratio, and indexing limits and verify CRC-32 plus
manifest SHA-256. Documents do not execute scripts, macros, notebook cells, or
extension code. Attachments remain inert until explicit extraction/opening.
External resources are not required and are not fetched without explicit user
consent.

## Source type proposal

- Type name: `text`
- Subtype name: `vnd.notmarkdown.source`
- Required parameter: `charset=UTF-8`
- File extension: `.nmt`
- Magic: exact leading version header `@notmarkdown 0.1`
- Published specification: NotMarkdown source grammar 0.1 or successor

Before submission, review the current IANA template, assign public contact and
change-controller information, publish stable specification URLs, document
fragment identifiers, and complete community review.

