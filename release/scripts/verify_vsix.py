#!/usr/bin/env python3
"""Verify that a NotMarkdown VSIX contains only the intended runtime payload."""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import PurePosixPath


REQUIRED = {
    "extension/package.json",
    "extension/license.txt",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/images/icon.png",
    "extension/dist/extension.js",
    "extension/language-configuration.json",
    "extension/snippets/notmarkdown.json",
    "extension/syntaxes/notmarkdown.tmLanguage.json",
}
FORBIDDEN_PARTS = {"node_modules", "src", "test", ".git", ".github", ".vscode"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix")
    args = parser.parse_args()
    try:
        with zipfile.ZipFile(args.vsix) as archive:
            names = archive.namelist()
    except (OSError, zipfile.BadZipFile) as error:
        print(f"error: invalid VSIX: {error}", file=sys.stderr)
        return 2

    unsafe: list[str] = []
    forbidden: list[str] = []
    normalized: set[str] = set()
    duplicates: list[str] = []
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            unsafe.append(name)
        if FORBIDDEN_PARTS.intersection(path.parts) or name.endswith((".map", ".ts", ".tsbuildinfo")):
            forbidden.append(name)
        folded = name.casefold()
        if folded in normalized:
            duplicates.append(name)
        normalized.add(folded)
    missing = sorted({name.casefold() for name in REQUIRED}.difference(normalized))
    if unsafe or forbidden or duplicates or missing:
        for name in sorted(unsafe):
            print(f"error: unsafe VSIX path: {name}", file=sys.stderr)
        for name in sorted(forbidden):
            print(f"error: forbidden VSIX payload: {name}", file=sys.stderr)
        for name in sorted(duplicates):
            print(f"error: duplicate case-insensitive VSIX path: {name}", file=sys.stderr)
        for name in missing:
            print(f"error: missing VSIX payload: {name}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
