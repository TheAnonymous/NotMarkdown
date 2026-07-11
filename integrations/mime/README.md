# NotMarkdown media-type integration

The package media type is:

```text
application/vnd.notmarkdown.document+zip
```

The `+zip` suffix is registered by IANA. The vendor-tree type itself remains a
draft until the 0.1 name and security contract are frozen and an Expert Review
registration is submitted.

The proposed source type is:

```text
text/vnd.notmarkdown.source; charset=utf-8
```

Until that type is registered, integrations should also accept `.nmt` as
`text/plain` by extension. They must not infer that an arbitrary plain-text file
is NotMarkdown without the required `@notmarkdown 0.1` header.

The 0.1 package makes deterministic identification possible: the first ZIP
member is the uncompressed eight-byte name `mimetype`, has no extra field, and
its payload is the exact package media type. `shared-mime-info.xml` uses that
normative prefix rather than identifying every ZIP archive as NotMarkdown.

`iana-registration-draft.md` is preparation material, not a submitted or
approved registration.

