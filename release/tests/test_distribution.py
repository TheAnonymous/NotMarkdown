from __future__ import annotations

import hashlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
PACKAGER = SCRIPTS / "package_binaries.py"
RENDERER = SCRIPTS / "render_distribution.py"
CHECKSUMS = SCRIPTS / "write_checksums.py"


class BinaryPackagingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.target_dir = self.root / "target"
        self.license = self.root / "LICENSE"
        self.license.write_text("MIT\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def stage(self, target: str) -> None:
        release = self.target_dir / target / "release"
        release.mkdir(parents=True)
        suffix = ".exe" if "windows" in target else ""
        for name in ("notmarkdown", "notmarkdown-lsp", "notmd-tui"):
            (release / f"{name}{suffix}").write_bytes(f"{target}:{name}\n".encode())

    def package(self, target: str, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(PACKAGER),
                "--target-dir",
                str(self.target_dir),
                "--target",
                target,
                "--version",
                "1.2.3",
                "--license",
                str(self.license),
                "--output-dir",
                str(output),
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_unix_tarball_is_deterministic_and_executable(self) -> None:
        target = "x86_64-unknown-linux-gnu"
        self.stage(target)
        first = self.root / "first"
        second = self.root / "second"
        for output in (first, second):
            result = self.package(target, output)
            self.assertEqual(result.returncode, 0, result.stderr)
        first_archive = next(first.iterdir())
        second_archive = next(second.iterdir())
        self.assertEqual(first_archive.read_bytes(), second_archive.read_bytes())
        with tarfile.open(first_archive, "r:gz") as archive:
            members = archive.getmembers()
            self.assertEqual(len(members), 4)
            modes = {Path(member.name).name: member.mode for member in members}
            self.assertEqual(modes["notmarkdown"], 0o755)
            self.assertEqual(modes["LICENSE"], 0o644)
            self.assertTrue(all(member.mtime == 315532800 for member in members))

    def test_windows_zip_is_deterministic(self) -> None:
        target = "x86_64-pc-windows-msvc"
        self.stage(target)
        first = self.root / "first"
        second = self.root / "second"
        for output in (first, second):
            result = self.package(target, output)
            self.assertEqual(result.returncode, 0, result.stderr)
        first_archive = next(first.iterdir())
        second_archive = next(second.iterdir())
        self.assertEqual(first_archive.read_bytes(), second_archive.read_bytes())
        with zipfile.ZipFile(first_archive) as archive:
            self.assertEqual(len(archive.namelist()), 4)
            self.assertTrue(any(name.endswith("/notmarkdown.exe") for name in archive.namelist()))

    def test_missing_binary_fails_closed(self) -> None:
        target = "aarch64-apple-darwin"
        result = self.package(target, self.root / "out")
        self.assertEqual(result.returncode, 2)
        self.assertIn("missing built binary", result.stderr)


class DistributionRenderingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.templates = self.root / "templates"
        self.artifacts.mkdir()
        self.templates.mkdir()
        targets = (
            ("x86_64-unknown-linux-gnu", ".tar.gz"),
            ("aarch64-unknown-linux-gnu", ".tar.gz"),
            ("x86_64-apple-darwin", ".tar.gz"),
            ("aarch64-apple-darwin", ".tar.gz"),
            ("x86_64-pc-windows-msvc", ".zip"),
            ("aarch64-pc-windows-msvc", ".zip"),
        )
        for target, extension in targets:
            filename = f"notmarkdown-tools-1.2.3-{target}{extension}"
            (self.artifacts / filename).write_bytes(filename.encode())
        (self.templates / "sample.json.in").write_text(
            '{"version":"@VERSION@","url":"@URL_WINDOWS_X64@","hash":"@SHA256_WINDOWS_X64@"}\n',
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_templates_and_checksums_are_generated(self) -> None:
        output = self.root / "rendered"
        rendered = subprocess.run(
            [
                sys.executable,
                "-B",
                str(RENDERER),
                "--artifacts-dir",
                str(self.artifacts),
                "--templates-dir",
                str(self.templates),
                "--output-dir",
                str(output),
                "--repository",
                "example/notmarkdown",
                "--version",
                "1.2.3",
                "--tag",
                "compatibility-kit-v1.2.3",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        content = (output / "sample.json").read_text(encoding="utf-8")
        self.assertNotIn("@", content)
        self.assertIn("example/notmarkdown/releases/download", content)

        checksums = subprocess.run(
            [sys.executable, "-B", str(CHECKSUMS), str(self.artifacts)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(checksums.returncode, 0, checksums.stderr)
        lines = (self.artifacts / "SHA256SUMS").read_text(encoding="ascii").splitlines()
        self.assertEqual(len(lines), 6)
        self.assertEqual(lines, sorted(lines, key=lambda line: line.split("  ", 1)[1]))
        for line in lines:
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, hashlib.sha256((self.artifacts / name).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
