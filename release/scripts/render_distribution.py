#!/usr/bin/env python3
"""Render package-manager templates from final release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path


TARGETS = {
    "LINUX_X64": ("x86_64-unknown-linux-gnu", ".tar.gz"),
    "LINUX_ARM64": ("aarch64-unknown-linux-gnu", ".tar.gz"),
    "MACOS_X64": ("x86_64-apple-darwin", ".tar.gz"),
    "MACOS_ARM64": ("aarch64-apple-darwin", ".tar.gz"),
    "WINDOWS_X64": ("x86_64-pc-windows-msvc", ".zip"),
    "WINDOWS_ARM64": ("aarch64-pc-windows-msvc", ".zip"),
}
TOKEN = re.compile(r"@[A-Z0-9_]+@")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--templates-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--repository", required=True, help="GitHub owner/name")
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        print("error: repository must be owner/name", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", args.version):
        print("error: version must be SemVer", file=sys.stderr)
        return 2
    if not re.fullmatch(r"compatibility-kit-v[0-9A-Za-z.+-]+", args.tag):
        print("error: unsafe release tag", file=sys.stderr)
        return 2
    if args.output_dir.exists():
        print(f"error: output already exists: {args.output_dir}", file=sys.stderr)
        return 2

    replacements = {
        "@VERSION@": args.version,
        "@REPOSITORY@": args.repository,
        "@TAG@": args.tag,
    }
    for token, (target, extension) in TARGETS.items():
        filename = f"notmarkdown-tools-{args.version}-{target}{extension}"
        artifact = args.artifacts_dir / filename
        if not artifact.is_file():
            print(f"error: missing release artifact: {artifact}", file=sys.stderr)
            return 2
        replacements[f"@FILENAME_{token}@"] = filename
        replacements[f"@URL_{token}@"] = (
            f"https://github.com/{args.repository}/releases/download/{args.tag}/{filename}"
        )
        replacements[f"@SHA256_{token}@"] = sha256(artifact)

    try:
        templates = sorted(path for path in args.templates_dir.rglob("*.in") if path.is_file())
        if not templates:
            raise ValueError("no templates found")
        for template in templates:
            relative = template.relative_to(args.templates_dir)
            destination = args.output_dir / relative.with_suffix("")
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = template.read_text(encoding="utf-8")
            for key, value in replacements.items():
                content = content.replace(key, value)
            unresolved = sorted(set(TOKEN.findall(content)))
            if unresolved:
                raise ValueError(f"unresolved token(s) in {relative}: {', '.join(unresolved)}")
            destination.write_text(content, encoding="utf-8", newline="\n")
    except (OSError, ValueError) as error:
        if args.output_dir.exists():
            shutil.rmtree(args.output_dir)
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
