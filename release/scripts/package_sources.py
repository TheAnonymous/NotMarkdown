#!/usr/bin/env python3
"""Build deterministic, GitHub-independent NotMarkdown source archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Optional

sys.dont_write_bytecode = True

from release_common import (
    CHECKSUM_NAME,
    COMPONENT_RE,
    FORMAT_ID,
    MANIFEST_NAME,
    ReleaseError,
    VERSION_RE,
    is_relative_to,
    normalized_archive_mode,
    parse_version_overrides,
    read_json,
    sha256_file,
    tree_digest,
    write_json,
)


MIN_ZIP_EPOCH = 315532800  # 1980-01-01T00:00:00Z
MAX_ZIP_EPOCH = 4354819198  # 2107-12-31T23:59:58Z


def arguments() -> argparse.Namespace:
    script_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Create deterministic NotMarkdown source release ZIPs."
    )
    parser.add_argument("--root", type=Path, default=script_root)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--component",
        action="append",
        default=[],
        help="Build only this component; repeat to select more than one.",
    )
    parser.add_argument(
        "--set-version",
        action="append",
        default=[],
        metavar="COMPONENT=VERSION",
        help="Override a configured component version without editing the config.",
    )
    parser.add_argument(
        "--source-date-epoch",
        type=int,
        help="Override SOURCE_DATE_EPOCH and the configured fixed timestamp.",
    )
    return parser.parse_args()


def validate_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict) or config.get("schema_version") != 1:
        raise ReleaseError("release config must be an object with schema_version 1")
    if config.get("archive_compression") != "stored":
        raise ReleaseError("v1 requires archive_compression to be 'stored'")
    components = config.get("components")
    if not isinstance(components, list) or not components:
        raise ReleaseError("release config must contain at least one component")
    seen: set[str] = set()
    for component in components:
        if not isinstance(component, dict):
            raise ReleaseError("each component must be an object")
        component_id = component.get("id")
        if not isinstance(component_id, str) or not COMPONENT_RE.fullmatch(component_id):
            raise ReleaseError(f"invalid component id: {component_id!r}")
        if component_id in seen:
            raise ReleaseError(f"duplicate component id: {component_id}")
        seen.add(component_id)
        for field in ("path", "version", "artifact", "archive_root"):
            if not isinstance(component.get(field), str) or not component[field]:
                raise ReleaseError(f"{component_id}.{field} must be a non-empty string")
        if not VERSION_RE.fullmatch(component["version"]):
            raise ReleaseError(f"unsafe configured version for {component_id}")
        includes = component.get("include_globs")
        if includes is not None and (
            not isinstance(includes, list)
            or not includes
            or not all(isinstance(item, str) and item for item in includes)
        ):
            raise ReleaseError(f"{component_id}.include_globs must be a non-empty string array")
    for field in ("exclude_globs", "executable_globs"):
        if not isinstance(config.get(field), list) or not all(
            isinstance(item, str) and item for item in config[field]
        ):
            raise ReleaseError(f"{field} must be an array of non-empty strings")
    return config


def source_version(component_root: Path, source: dict[str, Any]) -> str:
    kind = source.get("kind")
    source_file = source.get("file")
    if not isinstance(source_file, str) or not source_file:
        raise ReleaseError("version_source.file must be a non-empty string")
    path = (component_root / source_file).resolve()
    if not is_relative_to(path, component_root):
        raise ReleaseError(f"version source escapes component: {source_file}")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ReleaseError(f"cannot read version source {path}: {error}") from error

    if kind == "package-json":
        value = read_json(path)
        version = value.get("version") if isinstance(value, dict) else None
    elif kind == "cargo-workspace":
        section = re.search(
            r"(?ms)^\[workspace\.package\]\s*(.*?)(?=^\[|\Z)", text
        )
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"\s*$', section.group(1)) if section else None
        version = match.group(1) if match else None
    elif kind == "gradle-kotlin":
        match = re.search(r'(?m)^\s*version\s*=\s*"([^"]+)"\s*$', text)
        version = match.group(1) if match else None
    else:
        raise ReleaseError(f"unsupported version source kind: {kind!r}")

    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ReleaseError(f"cannot determine a safe version from {path}")
    return version


def excluded(relative_path: str, patterns: list[str]) -> bool:
    name = relative_path.rsplit("/", 1)[-1]
    return any(
        fnmatchcase(relative_path, pattern) or fnmatchcase(name, pattern)
        for pattern in patterns
    )


def collect_files(
    component_root: Path,
    patterns: list[str],
    include_patterns: Optional[list[str]],
    ignored_roots: list[Path],
) -> list[tuple[str, Path]]:
    result: list[tuple[str, Path]] = []
    for directory, directory_names, file_names in os.walk(
        component_root, topdown=True, followlinks=False
    ):
        directory_path = Path(directory).resolve()
        kept_directories: list[str] = []
        for name in sorted(directory_names):
            child = directory_path / name
            if child.is_symlink():
                raise ReleaseError(f"source bundles do not permit symlinks: {child}")
            relative = child.relative_to(component_root).as_posix()
            if any(is_relative_to(child, ignored) for ignored in ignored_roots):
                continue
            if not excluded(relative, patterns):
                kept_directories.append(name)
        directory_names[:] = kept_directories

        for name in sorted(file_names):
            path = directory_path / name
            if path.is_symlink():
                raise ReleaseError(f"source bundles do not permit symlinks: {path}")
            if not path.is_file():
                raise ReleaseError(f"source entry is not a regular file: {path}")
            if any(is_relative_to(path, ignored) for ignored in ignored_roots):
                continue
            relative = path.relative_to(component_root).as_posix()
            included = include_patterns is None or any(
                fnmatchcase(relative, pattern) for pattern in include_patterns
            )
            if included and not excluded(relative, patterns):
                result.append((relative, path))
    result.sort(key=lambda item: item[0].encode("utf-8"))
    if not result:
        raise ReleaseError(f"component has no source files: {component_root}")
    return result


def zip_datetime(epoch: int) -> tuple[int, int, int, int, int, int]:
    if epoch < MIN_ZIP_EPOCH or epoch > MAX_ZIP_EPOCH:
        raise ReleaseError("SOURCE_DATE_EPOCH must fit the ZIP 1980..2107 range")
    value = time.gmtime(epoch)
    return (value.tm_year, value.tm_mon, value.tm_mday, value.tm_hour, value.tm_min, value.tm_sec - value.tm_sec % 2)


def create_archive(
    output: Path,
    archive_root: str,
    source_files: list[tuple[str, Path]],
    timestamp: tuple[int, int, int, int, int, int],
    executable_globs: list[str],
) -> dict[str, Any]:
    digests: list[tuple[str, int, bytes]] = []
    total_size = 0
    with zipfile.ZipFile(
        output, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True
    ) as archive:
        for relative, path in source_files:
            data = path.read_bytes()
            content_digest = hashlib.sha256(data).digest()
            total_size += len(data)
            digests.append((relative, len(data), content_digest))

            info = zipfile.ZipInfo(f"{archive_root}/{relative}", date_time=timestamp)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.create_version = 20
            info.extract_version = 10
            info.external_attr = normalized_archive_mode(relative, executable_globs) << 16
            info.internal_attr = 0
            archive.writestr(info, data)

    return {
        "file_count": len(source_files),
        "uncompressed_size": total_size,
        "tree_sha256": tree_digest(digests),
    }


def safe_template(component_id: str, template: str, version: str) -> str:
    try:
        value = template.format(version=version)
    except (KeyError, ValueError) as error:
        raise ReleaseError(f"invalid template for {component_id}: {error}") from error
    if not value or Path(value).name != value or value in {".", ".."}:
        raise ReleaseError(f"unsafe generated name for {component_id}: {value!r}")
    if "\\" in value or "/" in value:
        raise ReleaseError(f"generated name cannot contain a path separator: {value!r}")
    return value


def prepare_output(output: Path) -> None:
    if not output.exists():
        return
    raise ReleaseError(f"output already exists; choose a new path: {output}")


def build() -> int:
    args = arguments()
    root = args.root.resolve()
    config_path = (args.config or root / "release" / "release-config.json").resolve()
    if args.output_dir.is_symlink():
        raise ReleaseError("output directory cannot be a symlink")
    output = args.output_dir.resolve()
    if not root.is_dir():
        raise ReleaseError(f"repository root is not a directory: {root}")
    if output == root or is_relative_to(root, output):
        raise ReleaseError("output cannot be the repository root or one of its parents")
    config = validate_config(read_json(config_path))
    overrides = parse_version_overrides(args.set_version)
    configured_ids = {item["id"] for item in config["components"]}
    unknown_overrides = sorted(set(overrides) - configured_ids)
    if unknown_overrides:
        raise ReleaseError(f"unknown version override(s): {', '.join(unknown_overrides)}")

    selected_ids = args.component or [item["id"] for item in config["components"]]
    if len(selected_ids) != len(set(selected_ids)):
        raise ReleaseError("a component was selected more than once")
    unknown_selected = sorted(set(selected_ids) - configured_ids)
    if unknown_selected:
        raise ReleaseError(f"unknown component(s): {', '.join(unknown_selected)}")

    configured_epoch = config.get("source_date_epoch")
    environment_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if args.source_date_epoch is not None:
        epoch = args.source_date_epoch
    elif environment_epoch is not None:
        try:
            epoch = int(environment_epoch)
        except ValueError as error:
            raise ReleaseError("SOURCE_DATE_EPOCH must be an integer") from error
    elif isinstance(configured_epoch, int):
        epoch = configured_epoch
    else:
        raise ReleaseError("source_date_epoch must be configured")
    timestamp = zip_datetime(epoch)

    prepare_output(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".notmarkdown-release-", dir=output.parent)).resolve()
    try:
        assert staging is not None
        ignored_roots = [output, staging]
        records: list[dict[str, Any]] = []
        artifact_names: set[str] = set()
        for component in config["components"]:
            component_id = component["id"]
            if component_id not in selected_ids:
                continue
            version = overrides.get(component_id, component["version"])
            if not VERSION_RE.fullmatch(version):
                raise ReleaseError(f"unsafe version for {component_id}: {version!r}")
            component_root = (root / component["path"]).resolve()
            if not component_root.is_dir() or not is_relative_to(component_root, root):
                raise ReleaseError(f"component path escapes or is missing: {component['path']}")
            version_source = component.get("version_source")
            if version_source is not None:
                detected = source_version(component_root, version_source)
                if detected != version:
                    raise ReleaseError(
                        f"{component_id} version {version!r} does not match its source {detected!r}; "
                        f"update the config or use --set-version {component_id}={detected}"
                    )

            artifact_name = safe_template(component_id, component["artifact"], version)
            archive_root = safe_template(component_id, component["archive_root"], version)
            if not artifact_name.endswith(".zip"):
                raise ReleaseError(f"artifact for {component_id} must end in .zip")
            if artifact_name in artifact_names:
                raise ReleaseError(f"duplicate artifact name: {artifact_name}")
            artifact_names.add(artifact_name)
            files = collect_files(
                component_root,
                config["exclude_globs"],
                component.get("include_globs"),
                ignored_roots,
            )
            metadata = create_archive(
                staging / artifact_name,
                archive_root,
                files,
                timestamp,
                config["executable_globs"],
            )
            archive_path = staging / artifact_name
            records.append(
                {
                    "archive_root": archive_root,
                    "component": component_id,
                    "file": artifact_name,
                    "file_count": metadata["file_count"],
                    "sha256": sha256_file(archive_path),
                    "tree_sha256": metadata["tree_sha256"],
                    "uncompressed_size": metadata["uncompressed_size"],
                    "version": version,
                    "zip_size": archive_path.stat().st_size,
                }
            )

        records.sort(key=lambda item: item["file"])
        manifest = {
            "archive_compression": "stored",
            "artifacts": records,
            "format": FORMAT_ID,
            "release_id": config.get("release_id"),
            "source_date_epoch": epoch,
            "zip_timestamp_utc": "%04d-%02d-%02dT%02d:%02d:%02dZ" % timestamp,
        }
        write_json(staging / MANIFEST_NAME, manifest)

        checksum_files = sorted([item["file"] for item in records] + [MANIFEST_NAME])
        checksum_text = "".join(
            f"{sha256_file(staging / name)}  {name}\n" for name in checksum_files
        )
        with (staging / CHECKSUM_NAME).open(
            "w", encoding="ascii", newline="\n"
        ) as handle:
            handle.write(checksum_text)
        staging.rename(output)
        staging = None
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)

    print(f"Created {len(records)} deterministic source archive(s) in {output}")
    print(f"Verify with: {Path(__file__).with_name('verify_release.py')} {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(build())
    except ReleaseError as error:
        print(f"release error: {error}", file=sys.stderr)
        raise SystemExit(2)
