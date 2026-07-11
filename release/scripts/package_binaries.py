#!/usr/bin/env python3
"""Create deterministic per-target NotMarkdown binary archives."""

from __future__ import annotations

import argparse
import gzip
import io
import stat
import sys
import tarfile
import zipfile
from pathlib import Path


EPOCH = 315532800  # 1980-01-01T00:00:00Z, also valid for ZIP.
BINARIES = ("notmarkdown", "notmarkdown-lsp", "notmd-tui")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--target-dir", type=Path, required=True)
    result.add_argument("--target", required=True)
    result.add_argument("--version", required=True)
    result.add_argument("--license", type=Path, required=True)
    result.add_argument("--output-dir", type=Path, required=True)
    return result


def source_files(target_dir: Path, target: str, license_path: Path) -> list[tuple[str, bytes, int]]:
    windows = "windows" in target
    suffix = ".exe" if windows else ""
    release = target_dir / target / "release"
    files: list[tuple[str, bytes, int]] = []
    for binary in BINARIES:
        source = release / f"{binary}{suffix}"
        if not source.is_file():
            raise FileNotFoundError(f"missing built binary: {source}")
        files.append((source.name, source.read_bytes(), 0o755))
    if not license_path.is_file():
        raise FileNotFoundError(f"missing license: {license_path}")
    files.append(("LICENSE", license_path.read_bytes(), 0o644))
    return files


def write_zip(path: Path, root: str, files: list[tuple[str, bytes, int]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content, mode in sorted(files):
            info = zipfile.ZipInfo(f"{root}/{name}", (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def write_tar_gz(path: Path, root: str, files: list[tuple[str, bytes, int]]) -> None:
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=EPOCH, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for name, content, mode in sorted(files):
                    info = tarfile.TarInfo(f"{root}/{name}")
                    info.size = len(content)
                    info.mode = mode
                    info.mtime = EPOCH
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    archive.addfile(info, io.BytesIO(content))


def main() -> int:
    args = parser().parse_args()
    if not args.version or any(character not in "0123456789.-+abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" for character in args.version):
        print("error: unsafe version", file=sys.stderr)
        return 2
    if not args.target or any(character not in "0123456789-_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" for character in args.target):
        print("error: unsafe target", file=sys.stderr)
        return 2

    try:
        files = source_files(args.target_dir, args.target, args.license)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        root = f"notmarkdown-tools-{args.version}-{args.target}"
        extension = ".zip" if "windows" in args.target else ".tar.gz"
        output = args.output_dir / f"{root}{extension}"
        if output.exists():
            raise FileExistsError(f"refusing to overwrite: {output}")
        if extension == ".zip":
            write_zip(output, root, files)
        else:
            write_tar_gz(output, root, files)
    except (FileNotFoundError, FileExistsError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
