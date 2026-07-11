use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_notmarkdown")
}

fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../")
        .join(path)
}

fn temporary(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "notmarkdown-cli-{label}-{}-{nonce}.{extension}",
        std::process::id()
    ))
}

fn temporary_directory(label: &str) -> PathBuf {
    let path = temporary(label, "dir");
    fs::create_dir(&path).expect("create temporary directory");
    path
}

#[test]
fn parse_matches_node_and_diff_reports_cdm_paths() {
    let source = fixture("notmarkdown-reference-parser/examples/basic.nmt");
    let rust = Command::new(binary())
        .args(["parse", "--compact"])
        .arg(&source)
        .output()
        .expect("run Rust parser");
    assert!(
        rust.status.success(),
        "{}",
        String::from_utf8_lossy(&rust.stderr)
    );

    let node_cli = fixture("notmarkdown-reference-parser/dist/cli.js");
    let node = Command::new("node")
        .arg(node_cli)
        .arg("parse")
        .arg(&source)
        .output()
        .expect("run Node parser");
    assert!(node.status.success());
    let rust_tree: Value = serde_json::from_slice(&rust.stdout).expect("Rust CDM");
    let node_tree: Value = serde_json::from_slice(&node.stdout).expect("Node CDM");
    assert_eq!(rust_tree, node_tree);

    let changed = temporary("changed-source", "nmt");
    let changed_source = fs::read_to_string(&source)
        .expect("source")
        .replace("NotMarkdown parser example", "Changed title");
    fs::write(&changed, changed_source).expect("write changed source");
    let diff = Command::new(binary())
        .args(["diff", "--compact"])
        .arg(&source)
        .arg(&changed)
        .output()
        .expect("run semantic diff");
    assert_eq!(diff.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&diff.stdout).expect("diff JSON");
    assert_eq!(report["equal"], false);
    assert_eq!(report["documentEqual"], false);
    assert!(
        report["documentChanges"]
            .as_array()
            .expect("changes")
            .iter()
            .any(|change| change["path"] == "/metadata/title")
    );
    fs::remove_file(changed).expect("remove changed source");
}

#[test]
fn navigation_commands_match_the_typescript_reference() {
    let source = fixture("notmarkdown-reference-parser/examples/comprehensive.nmt");
    let node_cli = fixture("notmarkdown-reference-parser/dist/cli.js");
    for arguments in [
        vec!["outline", "--compact"],
        vec!["index", "--compact"],
        vec!["search", "--compact", "--limit", "10", "demo-captions"],
    ] {
        let mut rust = Command::new(binary());
        let mut node = Command::new("node");
        node.arg(&node_cli);
        if arguments[0] == "search" {
            rust.args(&arguments[..4]).arg(&source).arg(arguments[4]);
            node.args(&arguments[..4]).arg(&source).arg(arguments[4]);
        } else {
            rust.args(&arguments).arg(&source);
            node.args(&arguments).arg(&source);
        }
        let rust = rust.output().expect("run Rust navigation command");
        let node = node.output().expect("run Node navigation command");
        assert!(
            rust.status.success(),
            "{}",
            String::from_utf8_lossy(&rust.stderr)
        );
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        let rust_json: Value = serde_json::from_slice(&rust.stdout).expect("Rust JSON");
        let node_json: Value = serde_json::from_slice(&node.stdout).expect("Node JSON");
        assert_eq!(rust_json, node_json, "command {} drifted", arguments[0]);
    }

    let package_source = fixture("notmarkdown-reference-parser/examples/search-package.nmt");
    let package = temporary("searchable-assets", "nmdoc");
    let mappings = [
        ("search-demo", "search-demo.webm"),
        ("search-captions", "search-captions.vtt"),
        ("search-transcript", "search-transcript.txt"),
        ("search-notes", "search-notes.md"),
    ];
    let mut pack = Command::new(binary());
    pack.arg("pack")
        .arg(&package_source)
        .args(["--profile", "portable"])
        .args(["--output", package.to_str().expect("package path")]);
    for (id, file) in mappings {
        pack.args([
            "--asset",
            &format!(
                "{id}={}",
                fixture(&format!("notmarkdown-reference-parser/examples/{file}")).display()
            ),
        ]);
    }
    let packed = pack.output().expect("pack searchable fixture");
    assert!(
        packed.status.success(),
        "{}",
        String::from_utf8_lossy(&packed.stderr)
    );

    for arguments in [
        vec!["index", "--compact"],
        vec!["search", "--compact", "--limit", "10", "spoken captions"],
        vec!["search", "--compact", "--limit", "10", "silent magnetic"],
        vec!["search", "--compact", "--limit", "10", "tidal-cycle"],
    ] {
        let mut rust = Command::new(binary());
        let mut node = Command::new("node");
        node.arg(&node_cli);
        if arguments[0] == "search" {
            rust.args(&arguments[..4]).arg(&package).arg(arguments[4]);
            node.args(&arguments[..4]).arg(&package).arg(arguments[4]);
        } else {
            rust.args(&arguments).arg(&package);
            node.args(&arguments).arg(&package);
        }
        let rust = rust.output().expect("run Rust package search");
        let node = node.output().expect("run Node package search");
        assert!(
            rust.status.success(),
            "{}",
            String::from_utf8_lossy(&rust.stderr)
        );
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        let rust_json: Value = serde_json::from_slice(&rust.stdout).expect("Rust package JSON");
        let node_json: Value = serde_json::from_slice(&node.stdout).expect("Node package JSON");
        assert_eq!(
            rust_json, node_json,
            "package command {} drifted",
            arguments[0]
        );
    }
    fs::remove_file(package).expect("remove searchable package");
}

#[test]
fn package_commands_are_deterministic_safe_and_interoperable() {
    let source = fixture("notmarkdown-reference-parser/examples/package.nmt");
    let asset = fixture("notmarkdown-reference-parser/examples/package-flow.svg");
    let first = temporary("first", "nmdoc");
    let second = temporary("second", "nmdoc");
    let portable = temporary("portable", "nmdoc");
    let unpacked = temporary("unpacked", "dir");
    let mapping = format!("package-flow={}", asset.display());

    for output in [&first, &second] {
        let result = Command::new(binary())
            .arg("pack")
            .arg(&source)
            .args(["--output", output.to_str().expect("output path")])
            .args(["--asset", &mapping])
            .output()
            .expect("pack modern package");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    assert_eq!(
        fs::read(&first).expect("first"),
        fs::read(&second).expect("second")
    );

    let node_cli = fixture("notmarkdown-reference-parser/dist/cli.js");
    assert!(
        Command::new("node")
            .arg(&node_cli)
            .arg("inspect")
            .arg(&first)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("Node inspect")
            .success()
    );

    let portable_result = Command::new(binary())
        .arg("pack")
        .arg(&source)
        .args(["--profile", "portable"])
        .args(["--output", portable.to_str().expect("portable path")])
        .args(["--asset", &mapping])
        .output()
        .expect("pack portable package");
    assert!(portable_result.status.success());
    let inspection = Command::new(binary())
        .args(["inspect", "--compact"])
        .arg(&portable)
        .output()
        .expect("inspect portable package");
    assert!(inspection.status.success());
    let inspection: Value = serde_json::from_slice(&inspection.stdout).expect("inspection JSON");
    assert_eq!(inspection["manifest"]["containerProfile"], "portable-0.1");
    assert_eq!(inspection["entries"][1]["compression"], "deflate");
    assert_eq!(inspection["validation"]["source"], "verified");
    assert_eq!(inspection["validation"]["representations"], "deferred");

    let verification = Command::new(binary())
        .args(["verify", "--compact"])
        .arg(&portable)
        .output()
        .expect("verify portable package");
    assert!(verification.status.success());
    let verification: Value =
        serde_json::from_slice(&verification.stdout).expect("verification JSON");
    assert_eq!(verification["status"], "verified");
    assert_eq!(verification["representations"], 1);

    let unpack = Command::new(binary())
        .arg("unpack")
        .arg(&first)
        .args(["--output", unpacked.to_str().expect("unpack path")])
        .output()
        .expect("unpack package");
    assert!(unpack.status.success());
    assert_eq!(
        fs::read(unpacked.join("assets/package-flow.svg")).expect("unpacked asset"),
        fs::read(&asset).expect("original asset")
    );
    let overwrite = Command::new(binary())
        .arg("unpack")
        .arg(&first)
        .args(["--output", unpacked.to_str().expect("unpack path")])
        .output()
        .expect("repeat unpack");
    assert_eq!(overwrite.status.code(), Some(1));

    let same = Command::new(binary())
        .args(["diff", "--compact"])
        .arg(&first)
        .arg(&second)
        .output()
        .expect("diff equal packages");
    assert!(same.status.success());
    let same: Value = serde_json::from_slice(&same.stdout).expect("same diff");
    assert_eq!(same["assets"]["compared"], true);

    let changed_asset = temporary("changed-asset", "svg");
    let mut changed_bytes = fs::read(&asset).expect("asset bytes");
    changed_bytes.push(b'\n');
    fs::write(&changed_asset, changed_bytes).expect("changed asset");
    let changed_package = temporary("changed-package", "nmdoc");
    let changed_mapping = format!("package-flow={}", changed_asset.display());
    let changed_pack = Command::new(binary())
        .arg("pack")
        .arg(&source)
        .args([
            "--output",
            changed_package.to_str().expect("changed package path"),
        ])
        .args(["--asset", &changed_mapping])
        .output()
        .expect("pack changed asset");
    assert!(changed_pack.status.success());
    let changed_diff = Command::new(binary())
        .args(["diff", "--compact"])
        .arg(&first)
        .arg(&changed_package)
        .output()
        .expect("diff changed asset");
    assert_eq!(changed_diff.status.code(), Some(1));
    let changed_diff: Value =
        serde_json::from_slice(&changed_diff.stdout).expect("asset diff JSON");
    assert_eq!(changed_diff["documentEqual"], true);
    assert_eq!(changed_diff["assets"]["changed"][0], "package-flow");

    for file in [first, second, portable, changed_asset, changed_package] {
        fs::remove_file(file).expect("remove test file");
    }
    fs::remove_dir_all(unpacked).expect("remove unpacked directory");
}

#[test]
fn compatibility_import_export_is_deterministic_and_reports_asset_fallbacks() {
    let directory = temporary_directory("compatibility");
    let markdown = directory.join("input.md");
    let image = directory.join("photo.png");
    fs::write(
        &markdown,
        "# Migration\n\nA *small* **document** with `code` and [HTTPS](https://example.test/path).\n\n> A quotation.\n\n3. Third\n4. Fourth\n\n- Alpha\n- Beta\n\n![A local image](photo.png)\n\n```rust\nfn main() {}\n```\n",
    )
    .expect("write Markdown");
    fs::write(&image, b"\x89PNG\r\n\x1a\nfixture").expect("write image");

    let first = directory.join("first.nmdoc");
    let second = directory.join("second.nmdoc");
    for output in [&first, &second] {
        let result = Command::new(binary())
            .arg("import")
            .arg(&markdown)
            .args(["--dialect", "commonmark", "--to", "nmdoc", "--output"])
            .arg(output)
            .output()
            .expect("import Markdown");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    assert_eq!(
        fs::read(&first).expect("first"),
        fs::read(&second).expect("second")
    );

    let inspection = Command::new(binary())
        .args(["inspect", "--compact"])
        .arg(&first)
        .output()
        .expect("inspect imported package");
    assert!(inspection.status.success());
    let inspection: Value = serde_json::from_slice(&inspection.stdout).expect("inspection");
    assert_eq!(inspection["manifest"]["containerProfile"], "portable-0.1");
    assert_eq!(inspection["manifest"]["assets"]["photo"]["kind"], "image");

    let textconv = Command::new(binary())
        .args(["git", "textconv"])
        .arg(&first)
        .output()
        .expect("semantic textconv");
    assert!(textconv.status.success());
    let semantic: Value = serde_json::from_slice(&textconv.stdout).expect("semantic JSON");
    assert_eq!(semantic["document"]["type"], "document");
    assert_eq!(semantic["assets"]["photo"]["kind"], "image");

    let packaged_source = Command::new(binary())
        .args(["git", "source"])
        .arg(&first)
        .output()
        .expect("package source textconv");
    assert!(packaged_source.status.success());
    assert!(String::from_utf8_lossy(&packaged_source.stdout).starts_with("@notmarkdown 0.1"));

    let markdown_export = directory.join("document.md");
    let markdown_report = directory.join("markdown-loss.json");
    let export = Command::new(binary())
        .arg("export")
        .arg(&first)
        .args(["--to", "markdown", "--output"])
        .arg(&markdown_export)
        .arg("--loss-report")
        .arg(&markdown_report)
        .output()
        .expect("export Markdown");
    assert!(export.status.success());
    let exported_markdown = fs::read_to_string(&markdown_export).expect("Markdown export");
    assert!(exported_markdown.starts_with("# Migration"));
    assert!(exported_markdown.contains("![A local image](asset:photo)"));
    let markdown_report: Value =
        serde_json::from_slice(&fs::read(&markdown_report).expect("Markdown loss report"))
            .expect("Markdown report JSON");
    assert!(
        markdown_report["items"]
            .as_array()
            .expect("Markdown loss items")
            .iter()
            .any(|item| item["code"] == "NMD-E022")
    );

    let html = directory.join("document.html");
    let report = directory.join("html-loss.json");
    let export = Command::new(binary())
        .arg("export")
        .arg(&first)
        .args(["--to", "html", "--output"])
        .arg(&html)
        .args(["--loss-report"])
        .arg(&report)
        .output()
        .expect("export HTML");
    assert!(
        export.status.success(),
        "{}",
        String::from_utf8_lossy(&export.stderr)
    );
    let html_text = fs::read_to_string(&html).expect("HTML");
    assert!(html_text.starts_with("<!doctype html>"));
    assert!(!html_text.contains("<script"));
    assert!(!html_text.contains("src=\"http"));
    assert!(!html_text.contains("url(http"));
    let report: Value =
        serde_json::from_slice(&fs::read(&report).expect("report")).expect("report JSON");
    assert_eq!(report["reportVersion"], "0.1");
    assert_eq!(report["lossless"], false);
    assert!(
        report["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|item| item["code"] == "NMD-E100")
    );
    fs::remove_dir_all(directory).expect("remove compatibility directory");
}

#[test]
fn compatibility_conversion_never_overwrites_and_rejects_invalid_input() {
    let directory = temporary_directory("compatibility-errors");
    let invalid_utf8 = directory.join("invalid.md");
    let invalid_output = directory.join("invalid.nmt");
    fs::write(&invalid_utf8, [0xff, 0xfe]).expect("write invalid UTF-8");
    let invalid = Command::new(binary())
        .arg("import")
        .arg(&invalid_utf8)
        .args(["--dialect", "commonmark", "--to", "nmt", "--output"])
        .arg(&invalid_output)
        .output()
        .expect("reject invalid UTF-8");
    assert_eq!(invalid.status.code(), Some(1));
    assert!(!invalid_output.exists());

    let unsupported = directory.join("unsupported.md");
    let unsupported_output = directory.join("unsupported.nmt");
    let loss = directory.join("unsupported-loss.json");
    fs::write(
        &unsupported,
        "| A | B |\n|---|---|\n| one | two |\n\n~~removed~~\n",
    )
    .expect("write unsupported Markdown");
    let rejected = Command::new(binary())
        .arg("import")
        .arg(&unsupported)
        .args(["--dialect", "github", "--to", "nmt", "--output"])
        .arg(&unsupported_output)
        .arg("--loss-report")
        .arg(&loss)
        .output()
        .expect("reject unsupported syntax");
    assert_eq!(rejected.status.code(), Some(1));
    assert!(!unsupported_output.exists());
    let loss: Value =
        serde_json::from_slice(&fs::read(&loss).expect("loss report")).expect("loss JSON");
    assert!(
        loss["items"]
            .as_array()
            .expect("loss items")
            .iter()
            .any(|item| item["severity"] == "error" && item["code"] == "NMD-I051")
    );

    let valid = directory.join("valid.md");
    let existing = directory.join("existing.nmt");
    fs::write(&valid, "# Valid\n").expect("valid Markdown");
    fs::write(&existing, "sentinel").expect("existing output");
    let overwrite = Command::new(binary())
        .arg("import")
        .arg(&valid)
        .args(["--dialect", "commonmark", "--to", "nmt", "--output"])
        .arg(&existing)
        .output()
        .expect("refuse overwrite");
    assert_eq!(overwrite.status.code(), Some(2));
    assert_eq!(fs::read_to_string(&existing).expect("sentinel"), "sentinel");
    fs::remove_dir_all(directory).expect("remove error directory");
}

#[test]
fn git_install_is_local_and_idempotent() {
    let directory = temporary_directory("git-install");
    let initialized = Command::new("git")
        .arg("init")
        .arg(&directory)
        .output()
        .expect("initialize Git repository");
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    for _ in 0..2 {
        let install = Command::new(binary())
            .args(["git", "install", "--local"])
            .arg(&directory)
            .output()
            .expect("install Git integration");
        assert!(
            install.status.success(),
            "{}",
            String::from_utf8_lossy(&install.stderr)
        );
    }
    let attributes = fs::read_to_string(directory.join(".gitattributes")).expect("attributes");
    assert_eq!(attributes.matches("managed by").count(), 1);
    assert_eq!(
        attributes.matches("*.nmdoc diff=notmarkdown -text").count(),
        1
    );
    let textconv = Command::new("git")
        .arg("-C")
        .arg(&directory)
        .args(["config", "--local", "--get", "diff.notmarkdown.textconv"])
        .output()
        .expect("read Git config");
    assert!(textconv.status.success());
    assert!(String::from_utf8_lossy(&textconv.stdout).contains("git textconv"));
    fs::remove_dir_all(directory).expect("remove Git directory");
}
