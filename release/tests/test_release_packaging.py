from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
PACKAGER = SCRIPTS / "package_sources.py"
VERIFIER = SCRIPTS / "verify_release.py"


class ReleasePackagingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "source"
        (self.root / "component" / "nested").mkdir(parents=True)
        (self.root / "component" / "node_modules").mkdir()
        (self.root / "component" / "package.json").write_text(
            '{"name":"fixture","version":"1.2.3"}\n', encoding="utf-8"
        )
        (self.root / "component" / "README.md").write_text("fixture\n", encoding="utf-8")
        (self.root / "component" / "excluded.txt").write_text(
            "not selected\n", encoding="utf-8"
        )
        (self.root / "component" / "nested" / "run.sh").write_text(
            "#!/bin/sh\nexit 0\n", encoding="utf-8"
        )
        (self.root / "component" / "node_modules" / "ignored.js").write_text(
            "ignored\n", encoding="utf-8"
        )
        config = {
            "schema_version": 1,
            "release_id": "fixture",
            "source_date_epoch": 315532800,
            "archive_compression": "stored",
            "exclude_globs": ["node_modules", "node_modules/**", "**/node_modules", "**/node_modules/**"],
            "executable_globs": ["*.sh", "**/*.sh"],
            "components": [
                {
                    "id": "fixture",
                    "path": "component",
                    "version": "1.2.3",
                    "artifact": "fixture-{version}-source.zip",
                    "archive_root": "fixture-{version}",
                    "include_globs": ["README.md", "nested/**", "package.json"],
                    "version_source": {"kind": "package-json", "file": "package.json"},
                }
            ],
        }
        self.config = self.root / "release-config.json"
        self.config.write_text(json.dumps(config), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_packager(self, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(PACKAGER),
                "--root",
                str(self.root),
                "--config",
                str(self.config),
                "--output-dir",
                str(output),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_repeated_builds_are_identical_and_verify(self) -> None:
        first = Path(self.temporary.name) / "first"
        second = Path(self.temporary.name) / "second"
        for output in (first, second):
            result = self.run_packager(output)
            self.assertEqual(result.returncode, 0, result.stderr)
            verified = subprocess.run(
                [sys.executable, "-B", str(VERIFIER), str(output)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(verified.returncode, 0, verified.stderr)

        first_files = sorted(path.name for path in first.iterdir())
        second_files = sorted(path.name for path in second.iterdir())
        self.assertEqual(first_files, second_files)
        for name in first_files:
            self.assertEqual(
                hashlib.sha256((first / name).read_bytes()).digest(),
                hashlib.sha256((second / name).read_bytes()).digest(),
                name,
            )

        archive_path = first / "fixture-1.2.3-source.zip"
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(
                archive.namelist(),
                [
                    "fixture-1.2.3/README.md",
                    "fixture-1.2.3/nested/run.sh",
                    "fixture-1.2.3/package.json",
                ],
            )
            modes = {info.filename: info.external_attr >> 16 for info in archive.infolist()}
            self.assertEqual(modes["fixture-1.2.3/README.md"], 0o100644)
            self.assertEqual(modes["fixture-1.2.3/nested/run.sh"], 0o100755)

    def test_tampering_is_rejected(self) -> None:
        output = Path(self.temporary.name) / "tampered"
        result = self.run_packager(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = output / "fixture-1.2.3-source.zip"
        data = bytearray(archive.read_bytes())
        data[10] ^= 1
        archive.write_bytes(data)
        verified = subprocess.run(
            [sys.executable, "-B", str(VERIFIER), str(output)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(verified.returncode, 2)
        self.assertIn("SHA-256 mismatch", verified.stderr)

    def test_unsafe_zip_member_is_rejected_after_valid_checksums(self) -> None:
        output = Path(self.temporary.name) / "unsafe"
        result = self.run_packager(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive_path = output / "fixture-1.2.3-source.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            info = zipfile.ZipInfo(
                "fixture-1.2.3/../escape.txt",
                date_time=(1980, 1, 1, 0, 0, 0),
            )
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.create_version = 20
            info.extract_version = 10
            info.external_attr = 0o100644 << 16
            archive.writestr(info, b"escape\n")

        manifest_path = output / "release-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        record = manifest["artifacts"][0]
        record["sha256"] = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        record["zip_size"] = archive_path.stat().st_size
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        checksums = {
            archive_path.name: record["sha256"],
            manifest_path.name: hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        }
        checksum_text = "".join(
            f"{checksums[name]}  {name}\n" for name in sorted(checksums)
        )
        (output / "SHA256SUMS").write_text(checksum_text, encoding="ascii")

        verified = subprocess.run(
            [sys.executable, "-B", str(VERIFIER), str(output)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(verified.returncode, 2)
        self.assertIn("unsafe ZIP member path", verified.stderr)

    def test_existing_output_is_never_overwritten(self) -> None:
        output = Path(self.temporary.name) / "existing"
        output.mkdir()
        marker = output / "keep.txt"
        marker.write_text("keep\n", encoding="utf-8")
        result = self.run_packager(output)
        self.assertEqual(result.returncode, 2)
        self.assertIn("output already exists", result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep\n")

    def test_version_mismatch_is_rejected(self) -> None:
        output = Path(self.temporary.name) / "mismatch"
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(PACKAGER),
                "--root",
                str(self.root),
                "--config",
                str(self.config),
                "--output-dir",
                str(output),
                "--set-version",
                "fixture=9.9.9",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("does not match its source", result.stderr)


if __name__ == "__main__":
    unittest.main()
