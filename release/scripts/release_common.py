#!/usr/bin/env python3
"""Shared, dependency-free helpers for deterministic NotMarkdown releases."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable


FORMAT_ID = "notmarkdown-source-release/v1"
CHECKSUM_NAME = "SHA256SUMS"
MANIFEST_NAME = "release-manifest.json"
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*$")
COMPONENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class ReleaseError(RuntimeError):
    """An expected release configuration or verification failure."""


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ReleaseError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle, object_pairs_hook=reject_duplicate_keys)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"cannot read JSON {path}: {error}") from error


def write_json(path: Path, value: Any) -> None:
    data = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(data)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(entries: Iterable[tuple[str, int, bytes]]) -> str:
    """Hash sorted path, size and content-digest tuples without ambiguity."""

    digest = hashlib.sha256()
    for path, size, content_digest in entries:
        path_bytes = path.encode("utf-8")
        digest.update(len(path_bytes).to_bytes(8, "big"))
        digest.update(path_bytes)
        digest.update(size.to_bytes(8, "big"))
        digest.update(content_digest)
    return digest.hexdigest()


def parse_version_overrides(values: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for value in values:
        component, separator, version = value.partition("=")
        if not separator or not COMPONENT_RE.fullmatch(component):
            raise ReleaseError(
                f"invalid --set-version {value!r}; expected component=version"
            )
        if not VERSION_RE.fullmatch(version):
            raise ReleaseError(f"unsafe version value for {component}: {version!r}")
        if component in overrides:
            raise ReleaseError(f"version for {component} was provided more than once")
        overrides[component] = version
    return overrides


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def normalized_archive_mode(relative_path: str, executable_globs: list[str]) -> int:
    from fnmatch import fnmatchcase

    executable = any(fnmatchcase(relative_path, pattern) for pattern in executable_globs)
    return 0o100755 if executable else 0o100644
