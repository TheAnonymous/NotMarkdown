#!/usr/bin/env python3
"""Verify NotMarkdown release checksums and deterministic ZIP metadata."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

sys.dont_write_bytecode = True

from release_common import (
    CHECKSUM_NAME,
    FORMAT_ID,
    MANIFEST_NAME,
    ReleaseError,
    read_json,
    sha256_file,
    tree_digest,
)


CHECKSUM_LINE_RE = re.compile(r"^([0-9a-f]{64})  ([^/\\]+)$")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify a deterministic NotMarkdown source release directory."
    )
    parser.add_argument("release_dir", type=Path)
    return parser.parse_args()


def parse_checksums(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError) as error:
        raise ReleaseError(f"cannot read {path}: {error}") from error
    result: dict[str, str] = {}
    for number, line in enumerate(lines, start=1):
        match = CHECKSUM_LINE_RE.fullmatch(line)
        if not match:
            raise ReleaseError(f"invalid checksum line {number}: {line!r}")
        digest, name = match.groups()
        if name in result:
            raise ReleaseError(f"duplicate checksum entry: {name}")
        result[name] = digest
    if list(result) != sorted(result):
        raise ReleaseError("checksum entries are not sorted by filename")
    return result


def zip_timestamp(value: Any) -> tuple[int, int, int, int, int, int]:
    if not isinstance(value, str):
        raise ReleaseError("manifest zip_timestamp_utc must be a string")
    match = re.fullmatch(
        r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z", value
    )
    if not match:
        raise ReleaseError("manifest zip_timestamp_utc is malformed")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def safe_member(name: str, root: str) -> str:
    if "\\" in name or name.startswith("/") or name.endswith("/"):
        raise ReleaseError(f"unsafe or non-file ZIP member: {name!r}")
    path = PurePosixPath(name)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ReleaseError(f"unsafe ZIP member path: {name!r}")
    prefix = f"{root}/"
    if not name.startswith(prefix) or name == prefix:
        raise ReleaseError(f"ZIP member is outside archive root {root!r}: {name!r}")
    relative = name[len(prefix) :]
    if not relative:
        raise ReleaseError("ZIP member has an empty relative path")
    return relative


def verify_archive(path: Path, record: dict[str, Any], timestamp: tuple[int, ...]) -> None:
    root = record.get("archive_root")
    if not isinstance(root, str) or not root:
        raise ReleaseError(f"invalid archive_root for {path.name}")
    digests: list[tuple[str, int, bytes]] = []
    total = 0
    try:
        with zipfile.ZipFile(path, "r") as archive:
            if archive.comment:
                raise ReleaseError(f"archive comment is not deterministic: {path.name}")
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if names != sorted(names, key=lambda name: name.encode("utf-8")):
                raise ReleaseError(f"ZIP entries are not sorted: {path.name}")
            if len(names) != len(set(names)):
                raise ReleaseError(f"duplicate ZIP entry: {path.name}")
            for info in infos:
                relative = safe_member(info.filename, root)
                if info.compress_type != zipfile.ZIP_STORED:
                    raise ReleaseError(f"unexpected compression in {path.name}: {info.filename}")
                if info.date_time != timestamp:
                    raise ReleaseError(f"non-normalized timestamp in {path.name}: {info.filename}")
                if info.create_system != 3 or info.create_version != 20:
                    raise ReleaseError(f"non-Unix creator metadata in {path.name}: {info.filename}")
                if info.extract_version != 10 or info.internal_attr != 0:
                    raise ReleaseError(f"non-normalized ZIP metadata in {path.name}: {info.filename}")
                mode = info.external_attr >> 16
                if mode not in {0o100644, 0o100755}:
                    raise ReleaseError(f"non-normalized mode in {path.name}: {info.filename}")
                if info.flag_bits & ~0x800:
                    raise ReleaseError(f"unexpected ZIP flags in {path.name}: {info.filename}")
                if info.extra or info.comment:
                    raise ReleaseError(f"unexpected ZIP metadata in {path.name}: {info.filename}")

                digest = hashlib.sha256()
                size = 0
                with archive.open(info, "r") as member:
                    for chunk in iter(lambda: member.read(1024 * 1024), b""):
                        digest.update(chunk)
                        size += len(chunk)
                if size != info.file_size:
                    raise ReleaseError(f"member size mismatch in {path.name}: {info.filename}")
                total += size
                digests.append((relative, size, digest.digest()))
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise ReleaseError(f"cannot verify ZIP {path}: {error}") from error

    expected_count = record.get("file_count")
    expected_total = record.get("uncompressed_size")
    if expected_count != len(digests):
        raise ReleaseError(f"file_count mismatch for {path.name}")
    if expected_total != total:
        raise ReleaseError(f"uncompressed_size mismatch for {path.name}")
    if record.get("tree_sha256") != tree_digest(digests):
        raise ReleaseError(f"tree_sha256 mismatch for {path.name}")
    if record.get("zip_size") != path.stat().st_size:
        raise ReleaseError(f"zip_size mismatch for {path.name}")


def verify() -> int:
    args = arguments()
    directory = args.release_dir.resolve()
    if not directory.is_dir():
        raise ReleaseError(f"release directory does not exist: {directory}")
    manifest = read_json(directory / MANIFEST_NAME)
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT_ID:
        raise ReleaseError("unrecognized release manifest format")
    if manifest.get("archive_compression") != "stored":
        raise ReleaseError("unsupported archive compression")
    records = manifest.get("artifacts")
    if not isinstance(records, list) or not records:
        raise ReleaseError("release manifest contains no artifacts")

    artifact_names: list[str] = []
    for record in records:
        if not isinstance(record, dict):
            raise ReleaseError("artifact record must be an object")
        name = record.get("file")
        if not isinstance(name, str) or Path(name).name != name or not name.endswith(".zip"):
            raise ReleaseError(f"unsafe artifact filename: {name!r}")
        if name in artifact_names:
            raise ReleaseError(f"duplicate artifact filename: {name}")
        artifact_names.append(name)
    if artifact_names != sorted(artifact_names):
        raise ReleaseError("artifact records are not sorted by filename")

    expected_files = set(artifact_names + [MANIFEST_NAME, CHECKSUM_NAME])
    actual_files: set[str] = set()
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file():
            raise ReleaseError(f"release entry is not a regular file: {path.name}")
        actual_files.add(path.name)
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        raise ReleaseError(f"release file set mismatch; missing={missing}, extra={extra}")

    checksums = parse_checksums(directory / CHECKSUM_NAME)
    checksum_targets = set(artifact_names + [MANIFEST_NAME])
    if set(checksums) != checksum_targets:
        raise ReleaseError("SHA256SUMS does not list exactly the archives and manifest")
    for name, expected in checksums.items():
        actual = sha256_file(directory / name)
        if actual != expected:
            raise ReleaseError(f"SHA-256 mismatch for {name}")

    timestamp = zip_timestamp(manifest.get("zip_timestamp_utc"))
    epoch = manifest.get("source_date_epoch")
    if not isinstance(epoch, int):
        raise ReleaseError("manifest source_date_epoch must be an integer")
    value = time.gmtime(epoch)
    epoch_timestamp = (
        value.tm_year,
        value.tm_mon,
        value.tm_mday,
        value.tm_hour,
        value.tm_min,
        value.tm_sec - value.tm_sec % 2,
    )
    if timestamp != epoch_timestamp:
        raise ReleaseError("manifest timestamp does not match source_date_epoch")
    for record in records:
        path = directory / record["file"]
        if record.get("sha256") != checksums[record["file"]]:
            raise ReleaseError(f"manifest SHA-256 mismatch for {path.name}")
        verify_archive(path, record, timestamp)

    print(f"Verified {len(records)} source archive(s) in {directory}")
    print("Checksums, file sets, ZIP paths, timestamps, modes and content trees are valid.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(verify())
    except ReleaseError as error:
        print(f"verification error: {error}", file=sys.stderr)
        raise SystemExit(2)
