#!/usr/bin/env python3
"""Read and validate versions used by the GitHub release workflow."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path


SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
TAG = re.compile(r"^compatibility-kit-v([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--tag", default="")
    parser.add_argument("--trigger", type=Path)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    try:
        cargo = tomllib.loads((root / "notmarkdown-rust" / "Cargo.toml").read_text(encoding="utf-8"))
        config = json.loads((root / "release" / "release-config.json").read_text(encoding="utf-8"))
        vscode = json.loads((root / "notmarkdown-vscode" / "package.json").read_text(encoding="utf-8"))
        versions = {component["id"]: component["version"] for component in config["components"]}
        rust_version = cargo["workspace"]["package"]["version"]
        compatibility_version = versions["compatibility-kit"]
        vscode_version = vscode["version"]
        if versions["rust"] != rust_version:
            raise ValueError("Rust version differs between Cargo.toml and release-config.json")
        if versions["vscode"] != vscode_version:
            raise ValueError("VS Code version differs between package.json and release-config.json")
        for label, version in (
            ("Rust", rust_version),
            ("Compatibility Kit", compatibility_version),
            ("VS Code", vscode_version),
        ):
            if not SEMVER.fullmatch(version):
                raise ValueError(f"{label} version is not SemVer: {version}")
        if args.tag and args.trigger:
            raise ValueError("use either --tag or --trigger, not both")
        release_tag = args.tag
        if args.trigger:
            trigger = json.loads(args.trigger.read_text(encoding="utf-8"))
            if trigger.get("schema_version") != 1:
                raise ValueError("release trigger schema_version must be 1")
            if trigger.get("enabled") is not True:
                raise ValueError("release trigger is not enabled")
            if trigger.get("compatibility_version") != compatibility_version:
                raise ValueError("release trigger Compatibility Kit version differs from release config")
            candidate = trigger.get("release_candidate")
            if not isinstance(candidate, int) or isinstance(candidate, bool) or candidate < 1:
                raise ValueError("release_candidate must be a positive integer")
            release_tag = f"compatibility-kit-v{compatibility_version}-rc.{candidate}"
        if release_tag:
            match = TAG.fullmatch(release_tag)
            if not match:
                raise ValueError("release tag must be compatibility-kit-v<semver>")
            tag_version = match.group(1)
            compatible = tag_version == compatibility_version or tag_version.startswith(
                f"{compatibility_version}-rc."
            )
            if not compatible:
                raise ValueError(
                    f"tag version {tag_version} differs from Compatibility Kit {compatibility_version}"
                )
    except (KeyError, OSError, json.JSONDecodeError, tomllib.TOMLDecodeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    values = {
        "compatibility_version": compatibility_version,
        "release_tag": release_tag,
        "rust_version": rust_version,
        "vscode_version": vscode_version,
    }
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8", newline="\n") as output:
            for key, value in values.items():
                output.write(f"{key}={value}\n")
    print(json.dumps(values, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
