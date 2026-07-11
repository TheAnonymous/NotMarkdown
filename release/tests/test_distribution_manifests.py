from __future__ import annotations

import json
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RENDERER = ROOT / "release" / "scripts" / "render_distribution.py"
VSIX_VERIFIER = ROOT / "release" / "scripts" / "verify_vsix.py"
TEMPLATES = ROOT / "integrations" / "package-managers" / "templates"


class ReleaseWorkflowManifestTest(unittest.TestCase):
    def test_workflow_uses_reviewed_actions_and_all_native_targets(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        for action in (
            "actions/checkout@v6",
            "actions/setup-node@v6",
            "actions/setup-python@v6",
            "actions/upload-artifact@v7",
            "actions/download-artifact@v8",
            "actions/attest@v4",
        ):
            self.assertIn(action, workflow)
        for target in (
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
            "x86_64-apple-darwin",
            "aarch64-apple-darwin",
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
        ):
            self.assertIn(target, workflow)
        self.assertIn("attestations: write", workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("subject-path: release-stage/final/*", workflow)
        self.assertIn('paths:\n      - "release/release-trigger.json"', workflow)
        self.assertIn("--prerelease", workflow)
        self.assertIn("--latest=false", workflow)
        self.assertIn('--target "$GITHUB_SHA"', workflow)
        self.assertIn("Refusing to mutate existing release", workflow)
        self.assertIn("Refusing to move existing tag", workflow)
        self.assertNotIn("--clobber", workflow)
        self.assertNotIn("gh release edit", workflow)
        self.assertNotIn("--draft", workflow)
        self.assertNotIn("VSCE_PAT", workflow)
        self.assertNotIn("PUBLISH_TOKEN", workflow)


class DesktopScaffoldManifestTest(unittest.TestCase):
    def test_node_lock_and_tauri_capabilities_are_consistent(self) -> None:
        desktop = ROOT / "integrations" / "desktop"
        package = json.loads((desktop / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((desktop / "package-lock.json").read_text(encoding="utf-8"))
        root_package = lock["packages"][""]
        self.assertEqual(lock["lockfileVersion"], 3)
        self.assertEqual(root_package["version"], package["version"])
        self.assertEqual(root_package["devDependencies"], package["devDependencies"])

        cargo = tomllib.loads((desktop / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"))
        self.assertFalse(cargo["package"]["publish"])
        config = json.loads(
            (desktop / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        self.assertFalse(config["bundle"]["active"])
        self.assertEqual(config["build"]["frontendDist"], "../../../notmarkdown-web-editor/dist")
        capability = json.loads(
            (desktop / "src-tauri" / "capabilities" / "default.json").read_text(encoding="utf-8")
        )
        self.assertEqual(capability["permissions"], ["core:default"])


class VsixPayloadVerifierTest(unittest.TestCase):
    REQUIRED = (
        "extension/package.json",
        "extension/LICENSE.txt",
        "extension/readme.md",
        "extension/changelog.md",
        "extension/images/icon.png",
        "extension/dist/extension.js",
        "extension/language-configuration.json",
        "extension/snippets/notmarkdown.json",
        "extension/syntaxes/notmarkdown.tmLanguage.json",
    )

    def test_expected_runtime_payload_passes_and_source_map_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            valid = Path(temporary) / "valid.vsix"
            invalid = Path(temporary) / "invalid.vsix"
            for path, extra in ((valid, ()), (invalid, ("extension/dist/extension.js.map",))):
                with zipfile.ZipFile(path, "w") as archive:
                    for name in (*self.REQUIRED, *extra):
                        archive.writestr(name, b"fixture\n")
            accepted = subprocess.run(
                [sys.executable, "-B", str(VSIX_VERIFIER), str(valid)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            rejected = subprocess.run(
                [sys.executable, "-B", str(VSIX_VERIFIER), str(invalid)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("extension.js.map", rejected.stderr)


class RealPackageTemplateTest(unittest.TestCase):
    VERSION = "1.2.3"
    TARGETS = (
        ("x86_64-unknown-linux-gnu", ".tar.gz"),
        ("aarch64-unknown-linux-gnu", ".tar.gz"),
        ("x86_64-apple-darwin", ".tar.gz"),
        ("aarch64-apple-darwin", ".tar.gz"),
        ("x86_64-pc-windows-msvc", ".zip"),
        ("aarch64-pc-windows-msvc", ".zip"),
    )

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        for target, extension in self.TARGETS:
            filename = f"notmarkdown-tools-{self.VERSION}-{target}{extension}"
            archive = self.artifacts / filename
            root = f"notmarkdown-tools-{self.VERSION}-{target}"
            suffix = ".exe" if "windows" in target else ""
            names = [f"{root}/{name}{suffix}" for name in ("notmarkdown", "notmarkdown-lsp", "notmd-tui")]
            names.append(f"{root}/LICENSE")
            if extension == ".zip":
                with zipfile.ZipFile(archive, "w") as output:
                    for name in names:
                        output.writestr(name, b"fixture\n")
            else:
                with tarfile.open(archive, "w:gz") as output:
                    for name in names:
                        info = tarfile.TarInfo(name)
                        info.size = len(b"fixture\n")
                        output.addfile(info, fileobj=__import__("io").BytesIO(b"fixture\n"))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_rendered_install_paths_exist_in_real_archive_layout(self) -> None:
        rendered = self.root / "rendered"
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(RENDERER),
                "--artifacts-dir",
                str(self.artifacts),
                "--templates-dir",
                str(TEMPLATES),
                "--output-dir",
                str(rendered),
                "--repository",
                "TheAnonymous/NotMarkdown",
                "--version",
                self.VERSION,
                "--tag",
                "compatibility-kit-v1.2.3",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        scoop = json.loads((rendered / "scoop" / "notmarkdown.json").read_text(encoding="utf-8"))
        for architecture, target in (
            ("64bit", "x86_64-pc-windows-msvc"),
            ("arm64", "aarch64-pc-windows-msvc"),
        ):
            archive = self.artifacts / f"notmarkdown-tools-{self.VERSION}-{target}.zip"
            with zipfile.ZipFile(archive) as package:
                members = set(package.namelist())
            for binary in scoop["architecture"][architecture]["bin"]:
                self.assertIn(binary.replace("\\", "/"), members)

        winget = (rendered / "winget" / "NotMarkdown.NotMarkdown.installer.yaml").read_text(
            encoding="utf-8"
        )
        winget_paths = [path.replace("\\", "/") for path in re.findall(r"RelativeFilePath: (.+)", winget)]
        zip_members: set[str] = set()
        for target in ("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"):
            with zipfile.ZipFile(
                self.artifacts / f"notmarkdown-tools-{self.VERSION}-{target}.zip"
            ) as package:
                zip_members.update(package.namelist())
        self.assertTrue(winget_paths)
        self.assertTrue(all(path in zip_members for path in winget_paths))

        formula = (rendered / "homebrew" / "notmarkdown.rb").read_text(encoding="utf-8")
        self.assertIn('chdir "notmarkdown-tools-#{version}-#{target}"', formula)
        self.assertNotIn("@", formula)


if __name__ == "__main__":
    unittest.main()
