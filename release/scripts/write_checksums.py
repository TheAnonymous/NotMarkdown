#!/usr/bin/env python3
"""Write a sorted SHA256SUMS file for a release asset directory."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", default="SHA256SUMS")
    args = parser.parse_args()
    if not args.directory.is_dir():
        print(f"error: not a directory: {args.directory}", file=sys.stderr)
        return 2
    output = args.directory / args.output
    files = sorted(
        path for path in args.directory.iterdir() if path.is_file() and path != output
    )
    if not files:
        print("error: no files to checksum", file=sys.stderr)
        return 2
    text = "".join(f"{sha256(path)}  {path.name}\n" for path in files)
    output.write_text(text, encoding="ascii", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
