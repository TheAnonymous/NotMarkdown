//! Local Compatibility Kit: bounded Markdown conversion and Git integration.

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsString,
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
};

use notmarkdown_core::{
    Block, CalloutKind, Document, FigureAttributes, Inline, ListItem, MediaKind, Reference,
    RenderableNotation, parse, preflight_static_visual, renderable_notation, to_cdm_value,
};
use notmarkdown_package::{
    AssetInput, ContainerProfile, Manifest, OpenedPackage, create_package, open,
    read_asset_representation,
};
use serde::Serialize;
use serde_json::Value;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINES: usize = 100_000;
const MAX_BLOCKS: usize = 100_000;
const MAX_INLINE_DEPTH: usize = 16;
const MAX_ASSETS: usize = 512;
const MAX_REPORT_ITEMS: usize = 4096;
const MAX_MIGRATION_FILES: usize = 10_000;
const MAX_MIGRATION_DEPTH: usize = 32;
const MAX_HTML_EMBEDDED_ASSET_BYTES: usize = 8 * 1024 * 1024;
const MAX_HTML_EMBEDDED_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_HTML_EMBEDDED_ASSETS: usize = 256;

#[derive(Debug)]
pub enum CompatError {
    Usage(String),
    Format(String),
    Operational(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Severity {
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Loss {
    code: String,
    severity: Severity,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LossReport {
    report_version: &'static str,
    operation: &'static str,
    source: String,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    dialect: Option<String>,
    lossless: bool,
    error_count: usize,
    warning_count: usize,
    truncated: bool,
    items: Vec<Loss>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationLossReport {
    report_version: &'static str,
    operation: &'static str,
    source: String,
    target: String,
    completed: bool,
    lossless: bool,
    files_discovered: usize,
    files_succeeded: usize,
    files_failed: usize,
    reports: Vec<LossReport>,
}

#[derive(Clone, Debug)]
struct EmbeddedHtmlAsset {
    media_type: String,
    data_url: String,
}

type EmbeddedHtmlAssets = BTreeMap<String, EmbeddedHtmlAsset>;

struct HtmlAssetRender<'a> {
    manifest: Option<&'a Manifest>,
    embedded: &'a EmbeddedHtmlAssets,
    path: &'a str,
    kind: &'a str,
    asset_id: &'a str,
    label: &'a str,
    plain_label: &'a str,
    decorative: bool,
}

impl LossReport {
    fn new(operation: &'static str, source: &Path, target: &Path, dialect: Option<&str>) -> Self {
        Self {
            report_version: "0.1",
            operation,
            source: source.display().to_string(),
            target: target.display().to_string(),
            dialect: dialect.map(str::to_owned),
            lossless: true,
            error_count: 0,
            warning_count: 0,
            truncated: false,
            items: Vec::new(),
        }
    }

    fn add(
        &mut self,
        severity: Severity,
        code: &str,
        message: impl Into<String>,
        line: Option<usize>,
        path: Option<String>,
        fallback: Option<String>,
    ) {
        self.lossless = false;
        match severity {
            Severity::Warning => self.warning_count += 1,
            Severity::Error => self.error_count += 1,
        }
        if self.items.len() >= MAX_REPORT_ITEMS {
            self.truncated = true;
            return;
        }
        self.items.push(Loss {
            code: code.into(),
            severity,
            message: message.into(),
            line,
            path,
            fallback,
        });
    }

    fn error(&mut self, code: &str, message: impl Into<String>, line: usize) {
        self.add(Severity::Error, code, message, Some(line), None, None);
    }

    fn warning(
        &mut self,
        code: &str,
        message: impl Into<String>,
        line: Option<usize>,
        path: Option<String>,
        fallback: impl Into<String>,
    ) {
        self.add(
            Severity::Warning,
            code,
            message,
            line,
            path,
            Some(fallback.into()),
        );
    }

    fn has_errors(&self) -> bool {
        self.error_count != 0
    }
}

pub fn import_command(mut args: Vec<String>) -> Result<u8, CompatError> {
    if args.is_empty() {
        return Err(CompatError::Usage("import requires an input path.".into()));
    }
    let input = PathBuf::from(args.remove(0));
    let dialect = required(&mut args, "--dialect")?;
    if !matches!(dialect.as_str(), "commonmark" | "github") {
        return Err(CompatError::Usage(
            "--dialect must be commonmark or github.".into(),
        ));
    }
    let target = required(&mut args, "--to")?;
    if !matches!(target.as_str(), "nmt" | "nmdoc") {
        return Err(CompatError::Usage("--to must be nmt or nmdoc.".into()));
    }
    let output = PathBuf::from(required(&mut args, "--output")?);
    let report_path = option(&mut args, "--loss-report")?.map(PathBuf::from);
    let recursive = flag(&mut args, "--recursive")?;
    let profile = match option(&mut args, "--profile")?
        .as_deref()
        .unwrap_or("portable")
    {
        "portable" | "portable-0.1" => ContainerProfile::Portable,
        "modern" | "modern-0.1" => ContainerProfile::Modern,
        value => return Err(CompatError::Usage(format!("Unknown profile {value}."))),
    };
    reject_extra(&args)?;

    if input.is_dir() {
        if !recursive {
            return Err(CompatError::Usage(
                "Importing a directory requires --recursive.".into(),
            ));
        }
        return import_directory(
            &input,
            &output,
            report_path.as_deref(),
            &dialect,
            &target,
            profile,
        );
    }
    if recursive {
        return Err(CompatError::Usage(
            "--recursive requires a directory input.".into(),
        ));
    }
    preflight(&output, report_path.as_deref())?;

    let mut report = LossReport::new("import", &input, &output, Some(&dialect));
    if let Err(error) = convert_markdown(&input, &output, &target, profile, &mut report) {
        record_unreported_import_error(&mut report, &error);
        emit(&report);
        if let Some(path) = report_path.as_deref() {
            write_json(path, &report)?;
        }
        return Err(error);
    }
    if let Some(path) = report_path.as_deref() {
        write_json(path, &report)?;
    } else {
        emit(&report);
    }
    println!("{}", absolute(&output)?.display());
    Ok(0)
}

fn convert_markdown(
    input: &Path,
    output: &Path,
    target: &str,
    profile: ContainerProfile,
    report: &mut LossReport,
) -> Result<(), CompatError> {
    let source = bounded_text(input)?;
    let base = input
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .canonicalize()
        .map_err(op)?;
    let (document, assets) = {
        let mut importer = Importer::new(&base, report);
        let document = importer.document(&source);
        (document, importer.assets)
    };
    if report.has_errors() {
        return Err(CompatError::Format(format!(
            "Import stopped after {} error(s); no document was written.",
            report.error_count
        )));
    }

    let nmt = to_nmt(&document)?;
    if !parse(&nmt).is_valid() {
        return Err(CompatError::Operational(
            "Generated source failed the NotMarkdown parser invariant.".into(),
        ));
    }
    if target == "nmt" {
        for asset in &assets {
            report.warning(
                "NMD-I210",
                format!(
                    "Loose .nmt cannot carry the bytes for asset {:?}.",
                    asset.id
                ),
                None,
                Some(format!("asset:{}", asset.id)),
                format!(
                    "Pack it later with --asset {}={}.",
                    asset.id,
                    asset.path.display()
                ),
            );
        }
        write_new(output, &nmt)
    } else {
        create_package(&nmt, &assets, profile, output)
            .map(|_| ())
            .map_err(|error| CompatError::Operational(error.to_string()))
    }
}

fn import_directory(
    input: &Path,
    output: &Path,
    requested_report_path: Option<&Path>,
    dialect: &str,
    target: &str,
    profile: ContainerProfile,
) -> Result<u8, CompatError> {
    if output.exists() {
        return Err(CompatError::Operational(format!(
            "Refusing to overwrite {}.",
            output.display()
        )));
    }
    if requested_report_path.is_some_and(Path::exists) {
        return Err(CompatError::Operational(format!(
            "Refusing to overwrite {}.",
            requested_report_path.expect("checked").display()
        )));
    }

    let root = input.canonicalize().map_err(op)?;
    if !root.is_dir() {
        return Err(CompatError::Usage(
            "--recursive requires a directory input.".into(),
        ));
    }
    let output_absolute = prospective_absolute(output)?;
    if output_absolute.starts_with(&root) {
        return Err(CompatError::Usage(
            "The recursive output directory must be outside the input tree.".into(),
        ));
    }
    if let Some(report_path) = requested_report_path {
        let report_absolute = prospective_absolute(report_path)?;
        if report_absolute.starts_with(&output_absolute) {
            return Err(CompatError::Usage(
                "A recursive --loss-report path must be outside the output directory; an embedded report is created automatically.".into(),
            ));
        }
    }

    let files = collect_markdown_files(&root)?;
    if files.is_empty() {
        return Err(CompatError::Format(
            "The input tree contains no .md or .markdown files.".into(),
        ));
    }

    let mut portable_targets = BTreeSet::new();
    let mut planned = Vec::with_capacity(files.len());
    for source in files {
        let relative = source
            .strip_prefix(&root)
            .map_err(|_| CompatError::Operational("Migration path escaped its root.".into()))?;
        let relative_target = relative.with_extension(target);
        let portable_key = portable_relative_path_key(&relative_target)?;
        if !portable_targets.insert(portable_key) {
            return Err(CompatError::Format(format!(
                "Two Markdown inputs map to the same portable target path: {}.",
                relative_target.display()
            )));
        }
        planned.push((source, relative_target));
    }

    if let Some(parent) = output.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(op)?;
    }
    let staging = unused_staging_directory(output)?;
    fs::create_dir(&staging).map_err(op)?;

    let mut reports = Vec::with_capacity(planned.len());
    let mut succeeded = 0_usize;
    for (source, relative_target) in &planned {
        let staged_target = staging.join(relative_target);
        let final_target = output.join(relative_target);
        let mut report = LossReport::new("import", source, &final_target, Some(dialect));
        let result = staged_target
            .parent()
            .ok_or_else(|| CompatError::Operational("Migration target has no parent.".into()))
            .and_then(|parent| fs::create_dir_all(parent).map_err(op))
            .and_then(|()| convert_markdown(source, &staged_target, target, profile, &mut report));
        match result {
            Ok(()) => succeeded += 1,
            Err(error) => record_unreported_import_error(&mut report, &error),
        }
        reports.push(report);
    }

    let failed = reports.len().saturating_sub(succeeded);
    let lossless = reports.iter().all(|report| report.lossless);
    for report in &reports {
        emit(report);
    }
    let migration_report = MigrationLossReport {
        report_version: "0.1",
        operation: "import-tree",
        source: root.display().to_string(),
        target: output_absolute.display().to_string(),
        completed: failed == 0,
        lossless,
        files_discovered: planned.len(),
        files_succeeded: succeeded,
        files_failed: failed,
        reports,
    };

    if failed != 0 {
        let _ = fs::remove_dir_all(&staging);
        let fallback_report = if let Some(path) = requested_report_path {
            path.to_path_buf()
        } else {
            unused_failure_report(output)?
        };
        write_json(&fallback_report, &migration_report)?;
        eprintln!(
            "NMD-I300 recursive import failed; complete report: {}",
            absolute(&fallback_report)?.display()
        );
        return Err(CompatError::Format(format!(
            "Recursive import failed for {failed} of {} Markdown files; no output directory was committed.",
            planned.len()
        )));
    }

    let embedded_name = "migration-loss-report.json";
    if let Err(error) = write_json(&staging.join(embedded_name), &migration_report) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, output) {
        let _ = fs::remove_dir_all(&staging);
        return Err(op(error));
    }
    let embedded_report = output.join(embedded_name);
    if let Some(report_path) = requested_report_path {
        write_json(report_path, &migration_report)?;
    }
    println!("{}", absolute(output)?.display());
    println!("loss report: {}", absolute(&embedded_report)?.display());
    Ok(0)
}

fn collect_markdown_files(root: &Path) -> Result<Vec<PathBuf>, CompatError> {
    fn visit(directory: &Path, depth: usize, files: &mut Vec<PathBuf>) -> Result<(), CompatError> {
        if depth > MAX_MIGRATION_DEPTH {
            return Err(CompatError::Format(format!(
                "Markdown migration exceeds the directory depth limit of {MAX_MIGRATION_DEPTH}."
            )));
        }
        let mut entries = fs::read_dir(directory)
            .map_err(op)?
            .map(|entry| entry.map(|entry| entry.path()).map_err(op))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort();
        for path in entries {
            let metadata = fs::symlink_metadata(&path).map_err(op)?;
            if metadata.file_type().is_symlink() {
                return Err(CompatError::Format(format!(
                    "Recursive migration refuses symbolic link {}.",
                    path.display()
                )));
            }
            if metadata.is_dir() {
                visit(&path, depth + 1, files)?;
            } else if metadata.is_file() && is_markdown_path(&path) {
                if files.len() >= MAX_MIGRATION_FILES {
                    return Err(CompatError::Format(format!(
                        "Markdown migration exceeds the {MAX_MIGRATION_FILES}-file limit."
                    )));
                }
                files.push(path);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, 0, &mut files)?;
    Ok(files)
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn portable_relative_path_key(path: &Path) -> Result<String, CompatError> {
    let mut normalized_components = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(CompatError::Format(format!(
                "Migration target path {} is not a portable relative path.",
                path.display()
            )));
        };
        let component = component.to_str().ok_or_else(|| {
            CompatError::Format(format!(
                "Migration target path {} contains a non-UTF-8 component.",
                path.display()
            ))
        })?;
        if component.nfc().collect::<String>() != component {
            return Err(CompatError::Format(format!(
                "Migration target component {component:?} is not canonical NFC Unicode."
            )));
        }
        validate_portable_component(component)?;
        let folded = component
            .nfkc()
            .case_fold()
            .collect::<String>()
            .nfc()
            .collect::<String>();
        validate_portable_component(&folded)?;
        normalized_components.push(folded);
    }
    if normalized_components.is_empty() {
        return Err(CompatError::Format(
            "Migration target path cannot be empty.".into(),
        ));
    }
    let key = normalized_components.join("/");
    if key.encode_utf16().count() > 1024 {
        return Err(CompatError::Format(
            "Migration target path exceeds the portable length limit.".into(),
        ));
    }
    Ok(key)
}

fn validate_portable_component(component: &str) -> Result<(), CompatError> {
    if component.is_empty()
        || component.ends_with([' ', '.'])
        || component
            .chars()
            .any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
        || component.encode_utf16().count() > 240
    {
        return Err(CompatError::Format(format!(
            "Migration target component {component:?} is not portable to Windows and macOS."
        )));
    }
    let device_name = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    let numbered_device = device_name
        .strip_prefix("COM")
        .or_else(|| device_name.strip_prefix("LPT"))
        .is_some_and(|number| number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9'));
    if matches!(
        device_name.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || numbered_device
    {
        return Err(CompatError::Format(format!(
            "Migration target component {component:?} uses a Windows-reserved device name."
        )));
    }
    Ok(())
}

fn prospective_absolute(path: &Path) -> Result<PathBuf, CompatError> {
    let mut cursor = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir().map_err(op)?.join(path)
    };
    let mut suffix = Vec::<OsString>::new();
    while !cursor.exists() {
        let name = cursor
            .file_name()
            .ok_or_else(|| CompatError::Operational("Cannot resolve output path.".into()))?;
        suffix.push(name.to_os_string());
        if !cursor.pop() {
            return Err(CompatError::Operational(
                "Cannot resolve output path.".into(),
            ));
        }
    }
    let mut resolved = cursor.canonicalize().map_err(op)?;
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn unused_staging_directory(output: &Path) -> Result<PathBuf, CompatError> {
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CompatError::Usage("Output directory needs a UTF-8 name.".into()))?;
    for suffix in 1..=1000 {
        let candidate = output.with_file_name(format!(
            ".{name}.notmarkdown-import-{}-{suffix}",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(CompatError::Operational(
        "Cannot allocate a staging directory for recursive import.".into(),
    ))
}

fn unused_failure_report(output: &Path) -> Result<PathBuf, CompatError> {
    let preferred = output.with_extension("loss.json");
    if !preferred.exists() {
        return Ok(preferred);
    }
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CompatError::Usage("Output directory needs a UTF-8 name.".into()))?;
    for suffix in 2..=1000 {
        let candidate = output.with_file_name(format!("{name}.loss-{suffix}.json"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(CompatError::Operational(
        "Cannot allocate a recursive import failure report path.".into(),
    ))
}

fn record_unreported_import_error(report: &mut LossReport, error: &CompatError) {
    if !report.has_errors() {
        report.add(
            Severity::Error,
            "NMD-I000",
            compat_error_message(error),
            None,
            None,
            Some("No output was committed for this input.".into()),
        );
    }
}

fn compat_error_message(error: &CompatError) -> &str {
    match error {
        CompatError::Usage(message)
        | CompatError::Format(message)
        | CompatError::Operational(message) => message,
    }
}

pub fn export_command(mut args: Vec<String>) -> Result<u8, CompatError> {
    if args.is_empty() {
        return Err(CompatError::Usage("export requires an input path.".into()));
    }
    let input = PathBuf::from(args.remove(0));
    let target = required(&mut args, "--to")?;
    if !matches!(target.as_str(), "markdown" | "html") {
        return Err(CompatError::Usage("--to must be markdown or html.".into()));
    }
    let output = PathBuf::from(required(&mut args, "--output")?);
    let report_path = option(&mut args, "--loss-report")?.map(PathBuf::from);
    reject_extra(&args)?;
    preflight(&output, report_path.as_deref())?;
    let mut report = LossReport::new("export", &input, &output, None);
    let loaded = match load(&input) {
        Ok(loaded) => loaded,
        Err(error) => {
            report.add(
                Severity::Error,
                "NMD-E000",
                compat_error_message(&error),
                None,
                None,
                Some("No export was written.".into()),
            );
            emit(&report);
            if let Some(path) = report_path.as_deref() {
                write_json(path, &report)?;
            }
            return Err(error);
        }
    };
    let rendered = if target == "markdown" {
        to_markdown(&loaded.document, &mut report)
    } else {
        to_html(
            &loaded.document,
            loaded.manifest.as_ref(),
            loaded.package.as_ref(),
            &mut report,
        )
    };
    write_new(&output, &rendered)?;
    if let Some(path) = report_path.as_deref() {
        write_json(path, &report)?;
    } else {
        emit(&report);
    }
    println!("{}", absolute(&output)?.display());
    Ok(0)
}

pub fn git_command(mut args: Vec<String>) -> Result<u8, CompatError> {
    let Some(command) = args.first().cloned() else {
        return Err(CompatError::Usage(
            "git requires install, textconv, or source.".into(),
        ));
    };
    args.remove(0);
    match command.as_str() {
        "install" => git_install(args),
        "textconv" | "semantic" => git_textconv(args),
        "source" => git_source(args),
        value => Err(CompatError::Usage(format!(
            "Unknown git subcommand {value}."
        ))),
    }
}

fn git_install(mut args: Vec<String>) -> Result<u8, CompatError> {
    let local = option(&mut args, "--local")?
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    reject_extra(&args)?;
    let result = Command::new("git")
        .arg("-C")
        .arg(&local)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(op)?;
    if !result.status.success() {
        return Err(CompatError::Operational(format!(
            "{} is not a Git work tree: {}",
            local.display(),
            String::from_utf8_lossy(&result.stderr).trim()
        )));
    }
    let root = PathBuf::from(String::from_utf8_lossy(&result.stdout).trim());
    let attributes = root.join(".gitattributes");
    let marker = "# NotMarkdown diff support (managed by `notmarkdown git install`)";
    let existing = fs::read_to_string(&attributes).unwrap_or_default();
    if !existing.lines().any(|line| line == marker) {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&attributes)
            .map_err(op)?;
        if !existing.is_empty() && !existing.ends_with('\n') {
            writeln!(file).map_err(op)?;
        }
        writeln!(file, "{marker}").map_err(op)?;
        writeln!(file, "*.nmdoc diff=notmarkdown -text").map_err(op)?;
        writeln!(file, "*.nmt diff=notmarkdown").map_err(op)?;
    }
    let executable = env::current_exe().map_err(op)?;
    let command = format!(
        "\"{}\" git textconv",
        executable.display().to_string().replace('"', "\\\"")
    );
    for (key, value) in [
        ("diff.notmarkdown.textconv", command.as_str()),
        ("diff.notmarkdown.cachetextconv", "true"),
        ("diff.notmarkdown.algorithm", "histogram"),
    ] {
        let result = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["config", "--local", key, value])
            .output()
            .map_err(op)?;
        if !result.status.success() {
            return Err(CompatError::Operational(format!(
                "git config failed: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            )));
        }
    }
    println!("configured {}", root.display());
    Ok(0)
}

fn git_textconv(args: Vec<String>) -> Result<u8, CompatError> {
    if args.len() != 1 {
        return Err(CompatError::Usage(
            "git textconv requires exactly one path.".into(),
        ));
    }
    let loaded = load(Path::new(&args[0]))?;
    #[derive(Serialize)]
    struct Output<'a> {
        document: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        assets: Option<&'a BTreeMap<String, notmarkdown_package::ManifestAsset>>,
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&Output {
            document: to_cdm_value(&loaded.document).map_err(op)?,
            assets: loaded.manifest.as_ref().map(|manifest| &manifest.assets),
        })
        .map_err(op)?
    );
    Ok(0)
}

fn git_source(args: Vec<String>) -> Result<u8, CompatError> {
    if args.len() != 1 {
        return Err(CompatError::Usage(
            "git source requires exactly one path.".into(),
        ));
    }
    let path = Path::new(&args[0]);
    let source = if extension(path) == Some("nmdoc") {
        open(path)
            .map_err(|error| CompatError::Format(error.to_string()))?
            .source
    } else {
        fs::read_to_string(path).map_err(op)?
    };
    print!("{source}");
    Ok(0)
}

struct Importer<'a> {
    base: &'a Path,
    report: &'a mut LossReport,
    assets: Vec<AssetInput>,
    paths: BTreeMap<PathBuf, String>,
    ids: BTreeSet<String>,
    block_count: usize,
}

impl<'a> Importer<'a> {
    fn new(base: &'a Path, report: &'a mut LossReport) -> Self {
        Self {
            base,
            report,
            assets: Vec::new(),
            paths: BTreeMap::new(),
            ids: BTreeSet::new(),
            block_count: 0,
        }
    }

    fn document(&mut self, source: &str) -> Document {
        let lines: Vec<&str> = source.lines().collect();
        if lines.first().is_some_and(|line| line.trim() == "---")
            && lines
                .iter()
                .skip(1)
                .take(100)
                .any(|line| line.trim() == "---")
        {
            self.report.error(
                "NMD-I001",
                "YAML front matter is outside the metadata-free importer slice.",
                1,
            );
        }
        let mut cursor = 0;
        let blocks = self.blocks(&lines, &mut cursor);
        Document {
            model_version: "0.1".into(),
            metadata: BTreeMap::new(),
            blocks,
            footnotes: BTreeMap::new(),
        }
    }

    fn blocks(&mut self, lines: &[&str], cursor: &mut usize) -> Vec<Block> {
        let mut output = Vec::new();
        while *cursor < lines.len() {
            if lines[*cursor].trim().is_empty() {
                *cursor += 1;
                continue;
            }
            if self.block_count >= MAX_BLOCKS {
                self.report
                    .error("NMD-I002", "Block limit exceeded.", *cursor + 1);
                break;
            }
            let line_no = *cursor + 1;
            let line = lines[*cursor].trim_end();
            if lines[*cursor].starts_with(' ') || lines[*cursor].starts_with('\t') {
                self.report.error(
                    "NMD-I020",
                    "Leading block indentation is outside this bounded subset; use an unindented block or fence.",
                    line_no,
                );
                *cursor += 1;
            } else if (line.starts_with("```") || line.starts_with("~~~"))
                && fence_open(line).is_none()
            {
                self.report.error(
                    "NMD-I023",
                    "Fence info strings must be one language token without spaces or fence characters.",
                    line_no,
                );
                *cursor += 1;
            } else if link_definition(line) {
                self.report.error(
                    "NMD-I052",
                    "Reference-style link definitions are outside this bounded importer slice.",
                    line_no,
                );
                *cursor += 1;
            } else if let Some((level, text)) = heading(line) {
                output.push(Block::Heading {
                    level,
                    children: self.inlines(text, line_no, 0),
                    id: None,
                });
                *cursor += 1;
            } else if thematic(line) {
                output.push(Block::ThematicBreak);
                *cursor += 1;
            } else if let Some((fence, count, language)) = fence_open(line) {
                *cursor += 1;
                let mut body = Vec::new();
                let mut closed = false;
                while *cursor < lines.len() {
                    if fence_close(lines[*cursor].trim(), fence, count) {
                        closed = true;
                        *cursor += 1;
                        break;
                    }
                    body.push(lines[*cursor]);
                    *cursor += 1;
                }
                if !closed {
                    self.report
                        .error("NMD-I021", "Fenced code block is not closed.", line_no);
                }
                if body.contains(&"```") {
                    self.report.error(
                        "NMD-I022",
                        "A line containing exactly ``` cannot be encoded by the 0.1 source fence.",
                        line_no,
                    );
                }
                output.push(Block::CodeBlock {
                    language,
                    text: body.join("\n"),
                });
            } else if line.starts_with('>') {
                let mut quote = Vec::new();
                while let Some(raw) = lines.get(*cursor) {
                    let Some(text) = raw.strip_prefix('>') else {
                        break;
                    };
                    let text = text.strip_prefix(' ').unwrap_or(text);
                    if starts_block(text) || text.starts_with('>') {
                        self.report.error(
                            "NMD-I030",
                            "Nested or block-structured quotes are outside this importer slice.",
                            *cursor + 1,
                        );
                    }
                    quote.push(text);
                    *cursor += 1;
                }
                let joined = join_lines(&quote);
                output.push(Block::Quote {
                    children: vec![Block::Paragraph {
                        children: self.inlines(&joined, line_no, 0),
                    }],
                });
            } else if let Some(first) = list_marker(line) {
                let (ordered, start, _) = first;
                if ordered && start == 0 {
                    self.report.error(
                        "NMD-I042",
                        "Ordered lists starting at zero cannot be represented by the 0.1 source grammar.",
                        line_no,
                    );
                }
                let mut items = Vec::new();
                while let Some(raw) = lines.get(*cursor) {
                    if raw.starts_with(' ') || raw.starts_with('\t') {
                        self.report.error(
                            "NMD-I040",
                            "Nested and continuation list lines are outside this importer slice.",
                            *cursor + 1,
                        );
                        *cursor += 1;
                        continue;
                    }
                    let Some((same_order, _, text)) = list_marker(raw.trim_end()) else {
                        break;
                    };
                    if same_order != ordered {
                        break;
                    }
                    if text.starts_with("[ ] ")
                        || text.starts_with("[x] ")
                        || text.starts_with("[X] ")
                    {
                        self.report.error(
                            "NMD-I041",
                            "GitHub task-list markers are not enabled in this slice.",
                            *cursor + 1,
                        );
                    }
                    items.push(ListItem {
                        checked: None,
                        blocks: vec![Block::Paragraph {
                            children: self.inlines(text, *cursor + 1, 0),
                        }],
                    });
                    *cursor += 1;
                }
                output.push(Block::List {
                    ordered,
                    start,
                    items,
                });
            } else if let Some((label, destination, consumed)) = link_parts(line, true)
                && consumed == line.len()
                && is_drawio_svg_path(clean_target(destination))
            {
                let label = inline_plain(&self.inlines(label, line_no, 0));
                if let Some(source_asset) = self.local_asset(destination, line_no, &["diagram"]) {
                    output.push(Block::Diagram {
                        diagram_type: "architecture".into(),
                        label: vec![Inline::Text { text: label }],
                        source_asset,
                    });
                    self.report.warning(
                        "NMD-I211",
                        "A draw.io editable SVG was adopted as a native static diagram.",
                        Some(line_no),
                        None,
                        "The bytes are embedded; the neutral architecture type can be refined after import.",
                    );
                }
                *cursor += 1;
            } else {
                if *cursor + 1 < lines.len() && setext(lines[*cursor + 1]) {
                    self.report.error(
                        "NMD-I050",
                        "Setext headings are unsupported; use # headings.",
                        line_no,
                    );
                }
                if *cursor + 1 < lines.len() && line.contains('|') && table_rule(lines[*cursor + 1])
                {
                    self.report.error(
                        "NMD-I051",
                        "GitHub tables require an explicit mapping and are not guessed.",
                        line_no,
                    );
                }
                let mut paragraph = vec![lines[*cursor]];
                *cursor += 1;
                while *cursor < lines.len()
                    && !lines[*cursor].trim().is_empty()
                    && !starts_block(lines[*cursor])
                {
                    paragraph.push(lines[*cursor]);
                    *cursor += 1;
                }
                let joined = join_lines(&paragraph);
                output.push(Block::Paragraph {
                    children: self.inlines(&joined, line_no, 0),
                });
            }
            self.block_count += 1;
        }
        output
    }

    fn inlines(&mut self, source: &str, line: usize, depth: usize) -> Vec<Inline> {
        if depth >= MAX_INLINE_DEPTH {
            self.report.error(
                "NMD-I100",
                format!("Inline nesting exceeds the depth limit of {MAX_INLINE_DEPTH}."),
                line,
            );
            return vec![Inline::Text {
                text: source.into(),
            }];
        }
        let mut output = Vec::new();
        let mut cursor = 0;
        while cursor < source.len() {
            let tail = &source[cursor..];
            if tail.starts_with("***") || tail.starts_with("___") {
                self.report.error(
                    "NMD-I101",
                    "Three emphasis delimiters are ambiguous; separate the spans.",
                    line,
                );
                push_text(&mut output, &tail[..3]);
                cursor += 3;
            } else if tail.starts_with("~~") {
                self.report.error(
                    "NMD-I102",
                    "Strikethrough has no 0.1 semantic node and is not flattened.",
                    line,
                );
                push_text(&mut output, "~~");
                cursor += 2;
            } else if tail.starts_with("``") {
                self.report.error(
                    "NMD-I103",
                    "Multi-backtick code spans are outside this bounded slice.",
                    line,
                );
                push_text(&mut output, "``");
                cursor += 2;
            } else if let Some(rest) = tail.strip_prefix('`') {
                if let Some(end) = rest.find('`') {
                    output.push(Inline::Code {
                        text: rest[..end].into(),
                    });
                    cursor += end + 2;
                } else {
                    push_text(&mut output, "`");
                    cursor += 1;
                }
            } else if tail.starts_with("![") {
                if let Some((label, target, consumed)) = link_parts(tail, true) {
                    let alt = if label.contains("![") {
                        self.report.error(
                            "NMD-I110",
                            "Nested images in alternative text are outside this importer slice.",
                            line,
                        );
                        label.into()
                    } else {
                        inline_plain(&self.inlines(label, line, depth + 1))
                    };
                    if let Some(asset_id) = self.image(target, line) {
                        output.push(Inline::Image {
                            asset_id,
                            alt: alt.clone(),
                            attributes: FigureAttributes::default(),
                            decorative: alt.is_empty(),
                        });
                    } else {
                        push_text(&mut output, &format!("[image: {alt}]"));
                    }
                    cursor += consumed;
                } else {
                    push_text(&mut output, "!");
                    cursor += 1;
                }
            } else if tail.starts_with("[^") {
                self.report.error(
                    "NMD-I104",
                    "Markdown footnotes are outside this CommonMark subset.",
                    line,
                );
                push_text(&mut output, "[");
                cursor += 1;
            } else if tail.starts_with('[') {
                if let Some((label, destination, consumed)) = link_parts(tail, false) {
                    let target = clean_target(destination);
                    let children = self.inlines(label, line, depth + 1);
                    if target.starts_with('#') {
                        self.report.warning(
                            "NMD-I109",
                            "CommonMark does not define generated heading IDs, so an anchor cannot be resolved safely.",
                            Some(line),
                            None,
                            "The original Markdown remains visible as literal text.",
                        );
                        push_text(&mut output, &format!("[{label}]({destination})"));
                    } else if is_drawio_source_path(target) {
                        if let Some(id) = self.local_asset(target, line, &["diagram"]) {
                            output.push(Inline::Link {
                                target: Reference::Asset { id },
                                children,
                            });
                            self.report.warning(
                                "NMD-I212",
                                "A local draw.io source link was adopted as an embedded diagram asset.",
                                Some(line),
                                None,
                                "The link label and editable source are preserved; no draw.io application code is embedded.",
                            );
                        } else {
                            push_text(&mut output, &format!("[{label}]({destination})"));
                        }
                    } else if valid_https(target) {
                        output.push(Inline::Link {
                            target: Reference::External { uri: target.into() },
                            children,
                        });
                    } else {
                        self.report.warning(
                            "NMD-I105",
                            format!(
                                "Link target {target:?} is not safe HTTPS or a valid heading ID."
                            ),
                            Some(line),
                            None,
                            "The original Markdown remains visible as literal text.",
                        );
                        push_text(&mut output, &format!("[{label}]({destination})"));
                    }
                    cursor += consumed;
                } else if tail.contains("][") {
                    self.report.error(
                        "NMD-I106",
                        "Reference-style links require definition resolution and are unsupported.",
                        line,
                    );
                    push_text(&mut output, "[");
                    cursor += 1;
                } else {
                    push_text(&mut output, "[");
                    cursor += 1;
                }
            } else if tail.starts_with("**") || tail.starts_with("__") {
                let marker = &tail[..2];
                if marker == "__" && previous_is_alphanumeric(source, cursor) {
                    push_text(&mut output, marker);
                    cursor += 2;
                } else if let Some(end) = tail[2..].find(marker) {
                    let body = &tail[2..end + 2];
                    let closing_end = end + 4;
                    if body.is_empty()
                        || (marker == "__" && next_is_alphanumeric(tail, closing_end))
                    {
                        push_text(&mut output, marker);
                        cursor += 2;
                    } else {
                        output.push(Inline::Strong {
                            children: self.inlines(body, line, depth + 1),
                        });
                        cursor += end + 4;
                    }
                } else {
                    push_text(&mut output, marker);
                    cursor += 2;
                }
            } else if tail.starts_with('*') || tail.starts_with('_') {
                let marker = &tail[..1];
                if marker == "_" && previous_is_alphanumeric(source, cursor) {
                    push_text(&mut output, marker);
                    cursor += 1;
                } else if let Some(end) = tail[1..].find(marker) {
                    let body = &tail[1..end + 1];
                    let closing_end = end + 2;
                    if body.is_empty() || (marker == "_" && next_is_alphanumeric(tail, closing_end))
                    {
                        push_text(&mut output, marker);
                        cursor += 1;
                    } else {
                        output.push(Inline::Emphasis {
                            children: self.inlines(body, line, depth + 1),
                        });
                        cursor += end + 2;
                    }
                } else {
                    push_text(&mut output, marker);
                    cursor += 1;
                }
            } else if tail.starts_with("\\\n") {
                output.push(Inline::HardBreak);
                cursor += 2;
            } else if tail.starts_with('\n') {
                push_text(&mut output, " ");
                cursor += 1;
            } else if tail.starts_with('<') {
                self.report.error(
                    "NMD-I107",
                    "Raw HTML and autolinks are not interpreted by the safe importer.",
                    line,
                );
                push_text(&mut output, "<");
                cursor += 1;
            } else if entity(tail) {
                self.report.error(
                    "NMD-I108",
                    "Replace character entities with their Unicode characters before import.",
                    line,
                );
                push_text(&mut output, "&");
                cursor += 1;
            } else if let Some(rest) = tail.strip_prefix('\\') {
                if let Some(character) = rest.chars().next()
                    && r#"\`*{}[]()#+-.!_>"#.contains(character)
                {
                    push_text(&mut output, &character.to_string());
                    cursor += 1 + character.len_utf8();
                } else {
                    push_text(&mut output, "\\");
                    cursor += 1;
                }
            } else {
                let character = tail.chars().next().expect("non-empty UTF-8");
                push_text(&mut output, &character.to_string());
                cursor += character.len_utf8();
            }
        }
        output
    }

    fn image(&mut self, destination: &str, line: usize) -> Option<String> {
        self.local_asset(destination, line, &["image"])
    }

    fn local_asset(
        &mut self,
        destination: &str,
        line: usize,
        accepted_kinds: &[&str],
    ) -> Option<String> {
        let destination = clean_target(destination).replace('\\', "/");
        let destination = destination.as_str();
        if destination.starts_with("https://") || destination.starts_with("http://") {
            self.report.warning(
                "NMD-I200",
                "Remote images are not fetched by the offline importer.",
                Some(line),
                None,
                "The image becomes an accessible text placeholder.",
            );
            return None;
        }
        if destination.is_empty() || destination.contains(['?', '#', '%']) {
            self.report.error(
                "NMD-I201",
                "Local image paths cannot contain query, fragment, or percent encoding.",
                line,
            );
            return None;
        }
        let relative = Path::new(destination);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            self.report.error(
                "NMD-I202",
                "Images must use relative paths inside the Markdown document directory.",
                line,
            );
            return None;
        }
        let path = match self.base.join(relative).canonicalize() {
            Ok(path) if path.starts_with(self.base) => path,
            Ok(_) => {
                self.report.error(
                    "NMD-I202",
                    "Image resolves outside the document directory.",
                    line,
                );
                return None;
            }
            Err(error) => {
                self.report.error(
                    "NMD-I203",
                    format!("Cannot read local image {destination:?}: {error}"),
                    line,
                );
                return None;
            }
        };
        if let Some(id) = self.paths.get(&path) {
            let compatible = self
                .assets
                .iter()
                .find(|asset| &asset.id == id)
                .is_some_and(|asset| accepted_kinds.contains(&asset.kind.as_str()));
            if compatible {
                return Some(id.clone());
            }
            self.report.error(
                "NMD-I205",
                "The referenced file kind is incompatible with this Markdown construct.",
                line,
            );
            return None;
        }
        if self.assets.len() >= MAX_ASSETS {
            self.report.error("NMD-I204", "Asset limit exceeded.", line);
            return None;
        }
        let id = self.asset_id(&path);
        let asset = match AssetInput::from_path(&id, &path) {
            Ok(asset) if accepted_kinds.contains(&asset.kind.as_str()) => asset,
            Ok(_) => {
                self.report.error(
                    "NMD-I205",
                    "The referenced file kind is incompatible with this Markdown construct.",
                    line,
                );
                return None;
            }
            Err(error) => {
                self.report.error("NMD-I205", error.to_string(), line);
                return None;
            }
        };
        self.ids.insert(id.clone());
        self.paths.insert(path, id.clone());
        self.assets.push(asset);
        Some(id)
    }

    fn asset_id(&self, path: &Path) -> String {
        let stem = path
            .file_stem()
            .and_then(|item| item.to_str())
            .unwrap_or("image");
        let mut base = String::new();
        for character in stem.chars().take(48) {
            if character.is_ascii_alphanumeric() {
                base.push(character.to_ascii_lowercase());
            } else if !base.ends_with('-') && !base.is_empty() {
                base.push('-');
            }
        }
        while base.ends_with('-') {
            base.pop();
        }
        if base.is_empty() || !base.as_bytes()[0].is_ascii_alphabetic() {
            base.insert_str(0, "image-");
        }
        let mut candidate = base.clone();
        let mut suffix = 2;
        while self.ids.contains(&candidate) {
            candidate = format!("{base}-{suffix}");
            suffix += 1;
        }
        candidate
    }
}

struct Loaded {
    document: Document,
    manifest: Option<Manifest>,
    package: Option<OpenedPackage>,
}

fn load(path: &Path) -> Result<Loaded, CompatError> {
    if extension(path) == Some("nmdoc") {
        let package = open(path).map_err(|error| CompatError::Format(error.to_string()))?;
        let document = package.document.clone();
        let manifest = package.manifest.clone();
        Ok(Loaded {
            document,
            manifest: Some(manifest),
            package: Some(package),
        })
    } else {
        let source = fs::read_to_string(path).map_err(op)?;
        let parsed = parse(&source);
        let document = parsed.document.ok_or_else(|| {
            let detail = parsed
                .diagnostics
                .first()
                .map(|item| format!("{}: {}", item.code, item.message))
                .unwrap_or_else(|| "invalid source".into());
            CompatError::Format(format!("{}: {detail}", path.display()))
        })?;
        Ok(Loaded {
            document,
            manifest: None,
            package: None,
        })
    }
}

fn to_nmt(document: &Document) -> Result<String, CompatError> {
    let mut output = String::from("@notmarkdown 0.1\n\n");
    for (index, block) in document.blocks.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        match block {
            Block::Heading {
                level, children, ..
            } => {
                output.push_str(&"#".repeat(usize::from(*level)));
                output.push(' ');
                output.push_str(&nmt_inlines(children));
                output.push('\n');
            }
            Block::Paragraph { children } => {
                output.push_str(&nmt_inlines(children));
                output.push('\n');
            }
            Block::ThematicBreak => output.push_str("---\n"),
            Block::Quote { children } => {
                let [Block::Paragraph { children }] = children.as_slice() else {
                    return Err(CompatError::Operational("Quote invariant failed.".into()));
                };
                for line in nmt_inlines(children).lines() {
                    output.push_str("> ");
                    output.push_str(line);
                    output.push('\n');
                }
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                for (item_index, item) in items.iter().enumerate() {
                    if *ordered {
                        output.push_str(&format!("{}. ", if item_index == 0 { *start } else { 1 }));
                    } else {
                        output.push_str("- ");
                    }
                    let [Block::Paragraph { children }] = item.blocks.as_slice() else {
                        return Err(CompatError::Operational("List invariant failed.".into()));
                    };
                    output.push_str(&nmt_inlines(children));
                    output.push('\n');
                }
            }
            Block::CodeBlock { language, text } => {
                output.push_str("```");
                output.push_str(language.as_deref().unwrap_or(""));
                output.push('\n');
                output.push_str(text);
                output.push_str("\n```\n");
            }
            Block::Diagram {
                diagram_type,
                label,
                source_asset,
            } => {
                output.push_str("!diagram[");
                output.push_str(&nmt_inlines(label));
                output.push_str("] {\n  type: ");
                output.push_str(diagram_type);
                output.push_str("\n  source: asset:");
                output.push_str(source_asset);
                output.push_str("\n}\n");
            }
            _ => {
                return Err(CompatError::Operational(
                    "Importer emitted an unsupported block.".into(),
                ));
            }
        }
    }
    Ok(output)
}

fn nmt_inlines(nodes: &[Inline]) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } => output.push_str(&escape_nmt(text)),
            Inline::Emphasis { children } => {
                output.push('*');
                output.push_str(&nmt_inlines(children));
                output.push('*');
            }
            Inline::Strong { children } => {
                output.push_str("**");
                output.push_str(&nmt_inlines(children));
                output.push_str("**");
            }
            Inline::Code { text } => {
                output.push('`');
                output.push_str(text);
                output.push('`');
            }
            Inline::Link { target, children } => {
                output.push('[');
                output.push_str(&nmt_inlines(children));
                output.push_str("](");
                output.push_str(&reference(target));
                output.push(')');
            }
            Inline::CrossReference { target, children } => {
                output.push('[');
                output.push_str(&nmt_inlines(children));
                output.push_str("](#");
                output.push_str(target);
                output.push(')');
            }
            Inline::Image {
                asset_id,
                alt,
                decorative,
                ..
            } => {
                output.push_str("![");
                output.push_str(&escape_nmt(alt));
                output.push_str("](asset:");
                output.push_str(asset_id);
                output.push(')');
                if *decorative {
                    output.push_str("{decorative=true}");
                }
            }
            Inline::HardBreak => output.push_str("\\\n"),
            Inline::FootnoteReference { target } => output.push_str(&format!("[^{target}]")),
            Inline::MathInline { source, .. } => {
                output.push('$');
                output.push_str(source);
                output.push('$');
            }
        }
    }
    output
}

fn to_markdown(document: &Document, report: &mut LossReport) -> String {
    for key in document.metadata.keys() {
        report.warning(
            "NMD-E001",
            format!("Metadata field {key:?} has no core Markdown representation."),
            None,
            Some(format!("/metadata/{key}")),
            "The field is omitted.",
        );
    }
    let mut output = String::new();
    markdown_blocks(&document.blocks, &mut output, report, "");
    for (id, blocks) in &document.footnotes {
        let mut body = String::new();
        markdown_blocks(blocks, &mut body, report, "/definitions/footnotes");
        output.push_str(&format!(
            "\n[^{id}]: {}\n",
            body.trim().replace('\n', "\n    ")
        ));
    }
    if !document.footnotes.is_empty() {
        report.warning(
            "NMD-E002",
            "Footnotes are emitted using a Markdown extension.",
            None,
            Some("/definitions/footnotes".into()),
            "Labels and definitions are preserved.",
        );
    }
    output
}

fn markdown_blocks(blocks: &[Block], output: &mut String, report: &mut LossReport, parent: &str) {
    for (index, block) in blocks.iter().enumerate() {
        if !output.is_empty() && !output.ends_with("\n\n") {
            if !output.ends_with('\n') {
                output.push('\n');
            }
            output.push('\n');
        }
        let path = format!("{parent}/children/{index}");
        match block {
            Block::Heading {
                level,
                children,
                id,
            } => {
                output.push_str(&"#".repeat(usize::from(*level)));
                output.push(' ');
                output.push_str(&markdown_inlines(children, report, &path));
                output.push('\n');
                if id.is_some() {
                    report.warning(
                        "NMD-E010",
                        "Explicit heading IDs are not core Markdown.",
                        None,
                        Some(path),
                        "The heading text is preserved; its explicit ID is omitted.",
                    );
                }
            }
            Block::Paragraph { children } => {
                output.push_str(&markdown_inlines(children, report, &path));
                output.push('\n');
            }
            Block::ThematicBreak => output.push_str("---\n"),
            Block::TableOfContents { .. } => report.warning(
                "NMD-E011",
                "An automatic contents node has no static CommonMark equivalent.",
                None,
                Some(path),
                "The generated contents list is omitted.",
            ),
            Block::Quote { children } => {
                let mut nested = String::new();
                markdown_blocks(children, &mut nested, report, &path);
                for line in nested.trim_end().lines() {
                    output.push_str("> ");
                    output.push_str(line);
                    output.push('\n');
                }
            }
            Block::List {
                ordered,
                start,
                items,
            } => markdown_list(*ordered, *start, items, output, report, &path, 0),
            Block::CodeBlock { language, text } => {
                let fence = markdown_fence(text);
                output.push_str(&fence);
                if let Some(language) = language {
                    if safe_markdown_info(language) {
                        output.push_str(language);
                    } else {
                        report.warning(
                            "NMD-E025",
                            "The code-block language is not a portable Markdown info token.",
                            None,
                            Some(path.clone()),
                            "The code remains intact and the unsafe language token is omitted.",
                        );
                    }
                }
                output.push('\n');
                output.push_str(text);
                if !text.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(&fence);
                output.push('\n');
            }
            Block::Callout { kind, children } => {
                output.push_str(&format!("> **{}:**\n>\n", callout_name(*kind)));
                let mut nested = String::new();
                markdown_blocks(children, &mut nested, report, &path);
                for line in nested.trim_end().lines() {
                    output.push_str("> ");
                    output.push_str(line);
                    output.push('\n');
                }
                report.warning(
                    "NMD-E012",
                    "Callout semantics are reduced to a labeled quotation.",
                    None,
                    Some(path),
                    "The label and body are preserved.",
                );
            }
            Block::Media {
                kind,
                label,
                asset_id,
                attributes,
                decorative,
                ..
            } => {
                let label = markdown_inlines(label, report, &path);
                if *kind == MediaKind::Image {
                    output.push_str(&format!("![{label}](asset:{asset_id})\n"));
                } else {
                    output.push_str(&format!("[{label}](asset:{asset_id})\n"));
                }
                markdown_asset_loss(report, &path, asset_id);
                if *kind != MediaKind::Image
                    || *decorative
                    || attributes != &notmarkdown_core::MediaAttributes::default()
                {
                    report.warning(
                        "NMD-E023",
                        "Media behavior and attributes are not portable Markdown.",
                        None,
                        Some(path),
                        "Kind, label, and the logical asset reference are preserved.",
                    );
                }
            }
            Block::Diagram {
                diagram_type,
                label,
                source_asset,
            } => {
                let label = markdown_inlines(label, report, &path);
                output.push_str(&format!(
                    "[Diagram ({diagram_type}): {label}](asset:{source_asset})\n"
                ));
                markdown_asset_loss(report, &path, source_asset);
            }
            Block::Chart {
                chart_type,
                label,
                data_asset,
            } => {
                let label = markdown_inlines(label, report, &path);
                output.push_str(&format!(
                    "[Chart ({chart_type}): {label}](asset:{data_asset})\n"
                ));
                markdown_asset_loss(report, &path, data_asset);
            }
            Block::MathBlock { source, .. } => {
                output.push_str("$$\n");
                output.push_str(source);
                output.push_str("\n$$\n");
                report.warning(
                    "NMD-E013",
                    "Math fences are a Markdown extension.",
                    None,
                    Some(path),
                    "The source expression is preserved.",
                );
            }
            Block::Attachment { label, asset_id } => {
                let label = markdown_inlines(label, report, &path);
                output.push_str(&format!("[{label}](asset:{asset_id})\n"));
                markdown_asset_loss(report, &path, asset_id);
            }
        }
    }
}

fn markdown_list(
    ordered: bool,
    start: usize,
    items: &[ListItem],
    output: &mut String,
    report: &mut LossReport,
    path: &str,
    indent: usize,
) {
    for (index, item) in items.iter().enumerate() {
        output.push_str(&" ".repeat(indent));
        if ordered {
            output.push_str(&format!("{}. ", if index == 0 { start } else { 1 }));
        } else {
            output.push_str("- ");
        }
        if let Some(checked) = item.checked {
            output.push_str(if checked { "[x] " } else { "[ ] " });
            report.warning(
                "NMD-E014",
                "Task state uses a Markdown extension.",
                None,
                Some(format!("{path}/children/{index}")),
                "The familiar checkbox marker is emitted.",
            );
        }
        for (block_index, block) in item.blocks.iter().enumerate() {
            match block {
                Block::Paragraph { children } if block_index == 0 => {
                    output.push_str(&markdown_inlines(children, report, path));
                    output.push('\n');
                }
                Block::List {
                    ordered,
                    start,
                    items,
                } => markdown_list(*ordered, *start, items, output, report, path, indent + 2),
                other => {
                    let mut nested = String::new();
                    markdown_blocks(std::slice::from_ref(other), &mut nested, report, path);
                    for line in nested.trim_end().lines() {
                        output.push_str(&" ".repeat(indent + 2));
                        output.push_str(line);
                        output.push('\n');
                    }
                }
            }
        }
    }
}

fn markdown_inlines(nodes: &[Inline], report: &mut LossReport, path: &str) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } => output.push_str(&escape_markdown(text)),
            Inline::Emphasis { children } => {
                output.push('*');
                output.push_str(&markdown_inlines(children, report, path));
                output.push('*');
            }
            Inline::Strong { children } => {
                output.push_str("**");
                output.push_str(&markdown_inlines(children, report, path));
                output.push_str("**");
            }
            Inline::Code { text } => {
                let marker = if text.contains('`') { "``" } else { "`" };
                output.push_str(marker);
                output.push_str(text);
                output.push_str(marker);
            }
            Inline::Link { target, children } => {
                output.push('[');
                output.push_str(&markdown_inlines(children, report, path));
                output.push_str("](");
                output.push_str(&reference(target));
                output.push(')');
                if let Reference::Asset { id } = target {
                    markdown_asset_loss(report, path, id);
                }
            }
            Inline::Image {
                asset_id,
                alt,
                attributes,
                decorative,
            } => {
                output.push_str(&format!("![{}](asset:{asset_id})", escape_markdown(alt)));
                markdown_asset_loss(report, path, asset_id);
                if attributes.layout.is_some() || *decorative {
                    report.warning(
                        "NMD-E023",
                        "Image layout or decorative state is not core Markdown.",
                        None,
                        Some(path.into()),
                        "Alt text and the logical asset reference are preserved.",
                    );
                }
            }
            Inline::HardBreak => output.push_str("  \n"),
            Inline::FootnoteReference { target } => output.push_str(&format!("[^{target}]")),
            Inline::CrossReference { target, children } => {
                output.push('[');
                output.push_str(&markdown_inlines(children, report, path));
                output.push_str("](#");
                output.push_str(target);
                output.push(')');
                report.warning(
                    "NMD-E024",
                    "CommonMark does not standardize heading IDs used by this cross-reference.",
                    None,
                    Some(path.into()),
                    "The explicit anchor target is preserved.",
                );
            }
            Inline::MathInline { source, .. } => {
                output.push('$');
                output.push_str(source);
                output.push('$');
                report.warning(
                    "NMD-E021",
                    "Inline math is a Markdown extension.",
                    None,
                    Some(path.into()),
                    "The source expression is preserved.",
                );
            }
        }
    }
    output
}

fn markdown_asset_loss(report: &mut LossReport, path: &str, asset_id: &str) {
    report.warning(
        "NMD-E022",
        format!("Embedded asset {asset_id:?} cannot travel inside a Markdown text file."),
        None,
        Some(path.into()),
        format!("A stable asset:{asset_id} reference is emitted."),
    );
}

fn to_html(
    document: &Document,
    manifest: Option<&Manifest>,
    package: Option<&OpenedPackage>,
    report: &mut LossReport,
) -> String {
    let title = document
        .metadata
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("NotMarkdown document");
    let language = document
        .metadata
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("en");
    let embedded = prepare_html_assets(document, package, report);
    let mut body = String::new();
    if !document.metadata.is_empty() {
        body.push_str("<dl class=metadata aria-label=\"Document metadata\">");
        for (key, value) in &document.metadata {
            body.push_str("<dt>");
            body.push_str(&html_escape(key));
            body.push_str("</dt><dd>");
            body.push_str(&html_escape(&scalar(value)));
            body.push_str("</dd>");
        }
        body.push_str("</dl>");
    }
    html_blocks(&document.blocks, &mut body, report, manifest, &embedded, "");
    if !document.footnotes.is_empty() {
        body.push_str("<section class=footnotes aria-label=Footnotes><h2>Footnotes</h2><ol>");
        for (id, blocks) in &document.footnotes {
            body.push_str(&format!("<li id=\"fn-{}\">", html_escape(id)));
            html_blocks(
                blocks,
                &mut body,
                report,
                manifest,
                &embedded,
                "/definitions/footnotes",
            );
            body.push_str("</li>");
        }
        body.push_str("</ol></section>");
    }
    format!(
        "<!doctype html>\n<html lang=\"{}\"><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\"><meta name=referrer content=no-referrer><meta name=generator content=\"NotMarkdown Compatibility Kit 0.1\"><title>{}</title><style>{}</style></head><body><main>{}</main></body></html>\n",
        html_escape(language),
        html_escape(title),
        HTML_STYLE,
        body
    )
}

fn html_blocks(
    blocks: &[Block],
    output: &mut String,
    report: &mut LossReport,
    manifest: Option<&Manifest>,
    embedded: &EmbeddedHtmlAssets,
    parent: &str,
) {
    for (index, block) in blocks.iter().enumerate() {
        let path = format!("{parent}/children/{index}");
        match block {
            Block::Heading {
                level,
                children,
                id,
            } => {
                output.push_str(&format!("<h{level}"));
                if let Some(id) = id {
                    output.push_str(&format!(" id=\"{}\"", html_escape(id)));
                }
                output.push('>');
                output.push_str(&html_inlines(children, report, manifest, embedded, &path));
                output.push_str(&format!("</h{level}>"));
            }
            Block::Paragraph { children } => {
                output.push_str("<p>");
                output.push_str(&html_inlines(children, report, manifest, embedded, &path));
                output.push_str("</p>");
            }
            Block::ThematicBreak => output.push_str("<hr>"),
            Block::TableOfContents { max_depth } => {
                output.push_str(
                    "<nav class=toc aria-label=\"Table of contents\"><strong>Contents</strong><ol>",
                );
                for candidate in blocks {
                    if let Block::Heading {
                        level,
                        children,
                        id,
                    } = candidate
                        && max_depth.is_none_or(|depth| *level <= depth)
                    {
                        output.push_str("<li>");
                        if let Some(id) = id {
                            output.push_str(&format!("<a href=\"#{}\">", html_escape(id)));
                            output.push_str(&html_inlines(
                                children, report, manifest, embedded, &path,
                            ));
                            output.push_str("</a>");
                        } else {
                            output.push_str(&html_inlines(
                                children, report, manifest, embedded, &path,
                            ));
                        }
                        output.push_str("</li>");
                    }
                }
                output.push_str("</ol></nav>");
            }
            Block::Quote { children } => {
                output.push_str("<blockquote>");
                html_blocks(children, output, report, manifest, embedded, &path);
                output.push_str("</blockquote>");
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                let tag = if *ordered { "ol" } else { "ul" };
                if *ordered && *start != 1 {
                    output.push_str(&format!("<{tag} start=\"{start}\">"));
                } else {
                    output.push_str(&format!("<{tag}>"));
                }
                for item in items {
                    output.push_str("<li>");
                    if let Some(checked) = item.checked {
                        output.push_str(if checked { "☑ " } else { "☐ " });
                    }
                    html_blocks(&item.blocks, output, report, manifest, embedded, &path);
                    output.push_str("</li>");
                }
                output.push_str(&format!("</{tag}>"));
            }
            Block::CodeBlock { language, text } => {
                if let Some(notation) = language.as_deref().and_then(renderable_notation) {
                    let (name, code) = match notation {
                        RenderableNotation::Mermaid => ("Mermaid", "NMD-E104"),
                        RenderableNotation::VegaLite => ("Vega-Lite", "NMD-E105"),
                    };
                    let preflight = preflight_static_visual(
                        language.as_deref().expect("notation requires language"),
                        text,
                    );
                    output.push_str(&format!(
                        "<figure class=\"visual-source {}\"><pre><code data-language=\"{}\">{}</code></pre><figcaption>{} source · static fallback</figcaption></figure>",
                        html_escape(&name.to_ascii_lowercase()),
                        html_escape(language.as_deref().expect("notation requires language")),
                        html_escape(text),
                        name
                    ));
                    let message = match preflight {
                        Ok(_) => format!(
                            "{name} requires a specialized static renderer which this script-free HTML exporter does not bundle."
                        ),
                        Err(error) => format!("{name} preflight refused the preview: {error}"),
                    };
                    report.warning(
                        code,
                        message,
                        None,
                        Some(path),
                        "The complete declarative source is emitted as escaped, inert text.",
                    );
                } else {
                    output.push_str("<pre><code");
                    if let Some(language) = language {
                        output.push_str(&format!(" data-language=\"{}\"", html_escape(language)));
                    }
                    output.push('>');
                    output.push_str(&html_escape(text));
                    output.push_str("</code></pre>");
                }
            }
            Block::Callout { kind, children } => {
                output.push_str(&format!(
                    "<aside class=\"callout {}\"><strong>{}</strong>",
                    callout_name(*kind).to_ascii_lowercase(),
                    callout_name(*kind)
                ));
                html_blocks(children, output, report, manifest, embedded, &path);
                output.push_str("</aside>");
            }
            Block::Media {
                kind,
                label,
                asset_id,
                attributes,
                decorative,
            } => {
                let plain_label = inline_plain(label);
                let label = html_inlines(label, report, manifest, embedded, &path);
                html_asset(
                    output,
                    report,
                    HtmlAssetRender {
                        manifest,
                        embedded,
                        path: &path,
                        kind: media_name(*kind),
                        asset_id,
                        label: &label,
                        plain_label: &plain_label,
                        decorative: *decorative,
                    },
                );
                if *decorative || attributes != &notmarkdown_core::MediaAttributes::default() {
                    report.warning(
                        "NMD-E101",
                        "Media layout and auxiliary relationships are not fully reproduced in static HTML.",
                        None,
                        Some(path),
                        "Verified primary media remains available with controls; auxiliary metadata stays in the source package.",
                    );
                }
            }
            Block::Diagram {
                diagram_type,
                label,
                source_asset,
            } => {
                let plain_label = inline_plain(label);
                let label = html_inlines(label, report, manifest, embedded, &path);
                let kind = format!("diagram · {diagram_type}");
                html_asset(
                    output,
                    report,
                    HtmlAssetRender {
                        manifest,
                        embedded,
                        path: &path,
                        kind: &kind,
                        asset_id: source_asset,
                        label: &label,
                        plain_label: &plain_label,
                        decorative: false,
                    },
                );
            }
            Block::Chart {
                chart_type,
                label,
                data_asset,
            } => {
                let plain_label = inline_plain(label);
                let label = html_inlines(label, report, manifest, embedded, &path);
                let kind = format!("chart · {chart_type}");
                html_asset(
                    output,
                    report,
                    HtmlAssetRender {
                        manifest,
                        embedded,
                        path: &path,
                        kind: &kind,
                        asset_id: data_asset,
                        label: &label,
                        plain_label: &plain_label,
                        decorative: false,
                    },
                );
            }
            Block::MathBlock { notation, source } => output.push_str(&format!(
                "<figure class=math><pre>{}</pre><figcaption>Math ({})</figcaption></figure>",
                html_escape(source),
                html_escape(notation)
            )),
            Block::Attachment { label, asset_id } => {
                let plain_label = inline_plain(label);
                let label = html_inlines(label, report, manifest, embedded, &path);
                html_asset(
                    output,
                    report,
                    HtmlAssetRender {
                        manifest,
                        embedded,
                        path: &path,
                        kind: "attachment",
                        asset_id,
                        label: &label,
                        plain_label: &plain_label,
                        decorative: false,
                    },
                );
            }
        }
    }
}

fn html_inlines(
    nodes: &[Inline],
    report: &mut LossReport,
    manifest: Option<&Manifest>,
    embedded: &EmbeddedHtmlAssets,
    path: &str,
) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } => output.push_str(&html_escape(text)),
            Inline::Emphasis { children } => output.push_str(&format!(
                "<em>{}</em>",
                html_inlines(children, report, manifest, embedded, path)
            )),
            Inline::Strong { children } => output.push_str(&format!(
                "<strong>{}</strong>",
                html_inlines(children, report, manifest, embedded, path)
            )),
            Inline::Code { text } => {
                output.push_str(&format!("<code>{}</code>", html_escape(text)));
            }
            Inline::Link { target, children } => {
                let label = html_inlines(children, report, manifest, embedded, path);
                match target {
                    Reference::External { uri } => output.push_str(&format!(
                        "<a href=\"{}\" rel=\"noreferrer noopener\">{label}</a>",
                        html_escape(uri)
                    )),
                    Reference::Internal { id } => {
                        output.push_str(&format!("<a href=\"#{}\">{label}</a>", html_escape(id)))
                    }
                    Reference::Asset { id } => {
                        output.push_str(&format!(
                            "<span class=asset-ref>{label} <code>asset:{}</code></span>",
                            html_escape(id)
                        ));
                        html_asset_loss(report, path, id, manifest);
                    }
                }
            }
            Inline::Image {
                asset_id,
                alt,
                attributes,
                decorative,
            } => {
                if let Some(asset) = embedded.get(asset_id)
                    && allowed_embedded_media_type("image", &asset.media_type)
                {
                    let escaped_alt = if *decorative {
                        String::new()
                    } else {
                        html_escape(alt)
                    };
                    output.push_str(&format!(
                        "<img class=\"asset inline-image\" src=\"{}\" alt=\"{}\"{}>",
                        asset.data_url,
                        escaped_alt,
                        if *decorative { " aria-hidden=true" } else { "" }
                    ));
                } else if *decorative {
                    output.push_str("<span class=\"asset inline-image\" aria-hidden=true>Decorative image</span>");
                    html_asset_loss(report, path, asset_id, manifest);
                } else {
                    output.push_str(&format!(
                        "<span class=\"asset inline-image\" role=img aria-label=\"{}\">Image · {}</span>",
                        html_escape(alt),
                        html_escape(alt)
                    ));
                    html_asset_loss(report, path, asset_id, manifest);
                }
                if attributes.layout.is_some() {
                    report.warning(
                        "NMD-E102",
                        "Inline image layout is not reproduced by the generic HTML theme.",
                        None,
                        Some(path.into()),
                        "Alt text, decorative state, and asset metadata are preserved.",
                    );
                }
            }
            Inline::HardBreak => output.push_str("<br>"),
            Inline::FootnoteReference { target } => output.push_str(&format!(
                "<sup><a href=\"#fn-{}\">{}</a></sup>",
                html_escape(target),
                html_escape(target)
            )),
            Inline::CrossReference { target, children } => output.push_str(&format!(
                "<a href=\"#{}\">{}</a>",
                html_escape(target),
                html_inlines(children, report, manifest, embedded, path)
            )),
            Inline::MathInline { notation, source } => output.push_str(&format!(
                "<code class=math data-notation=\"{}\">{}</code>",
                html_escape(notation),
                html_escape(source)
            )),
        }
    }
    output
}

fn prepare_html_assets(
    document: &Document,
    package: Option<&OpenedPackage>,
    report: &mut LossReport,
) -> EmbeddedHtmlAssets {
    let Some(package) = package else {
        return BTreeMap::new();
    };
    let mut embedded = BTreeMap::new();
    let mut total_bytes = 0_usize;
    for asset_id in html_primary_asset_ids(document) {
        if embedded.len() >= MAX_HTML_EMBEDDED_ASSETS {
            html_embed_loss(
                report,
                &asset_id,
                "the HTML embedded-asset count limit was reached",
            );
            continue;
        }
        let Some(asset) = package.manifest.assets.get(&asset_id) else {
            continue;
        };
        if !matches!(asset.kind.as_str(), "image" | "audio" | "video") {
            continue;
        }
        let mut candidates = asset
            .representations
            .iter()
            .filter(|representation| {
                allowed_embedded_media_type(&asset.kind, &representation.media_type)
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            (left.role != "playback")
                .cmp(&(right.role != "playback"))
                .then_with(|| {
                    embedded_media_priority(&left.media_type)
                        .cmp(&embedded_media_priority(&right.media_type))
                })
                .then_with(|| left.path.cmp(&right.path))
        });
        let Some(representation) = candidates.first().copied() else {
            html_embed_loss(
                report,
                &asset_id,
                "it has no allowlisted browser media representation",
            );
            continue;
        };
        let Ok(bytes) = usize::try_from(representation.bytes) else {
            html_embed_loss(
                report,
                &asset_id,
                "its declared byte length is not representable",
            );
            continue;
        };
        if bytes > MAX_HTML_EMBEDDED_ASSET_BYTES {
            html_embed_loss(
                report,
                &asset_id,
                "it exceeds the 8 MiB per-asset HTML limit",
            );
            continue;
        }
        if total_bytes.saturating_add(bytes) > MAX_HTML_EMBEDDED_TOTAL_BYTES {
            html_embed_loss(
                report,
                &asset_id,
                "it exceeds the 24 MiB total HTML media budget",
            );
            continue;
        }
        let data = match read_asset_representation(
            package,
            &asset_id,
            &representation.path,
            MAX_HTML_EMBEDDED_ASSET_BYTES,
        ) {
            Ok(data) => data,
            Err(error) => {
                html_embed_loss(
                    report,
                    &asset_id,
                    &format!("its representation could not be verified: {error}"),
                );
                continue;
            }
        };
        if !safe_embedded_payload(&representation.media_type, &data) {
            html_embed_loss(
                report,
                &asset_id,
                "its bytes failed the media signature or static SVG safety policy",
            );
            continue;
        }
        total_bytes += data.len();
        embedded.insert(
            asset_id,
            EmbeddedHtmlAsset {
                media_type: representation.media_type.clone(),
                data_url: format!(
                    "data:{};base64,{}",
                    representation.media_type,
                    base64_encode(&data)
                ),
            },
        );
    }
    embedded
}

fn html_primary_asset_ids(document: &Document) -> BTreeSet<String> {
    fn visit_inlines(nodes: &[Inline], ids: &mut BTreeSet<String>) {
        for node in nodes {
            match node {
                Inline::Image { asset_id, .. } => {
                    ids.insert(asset_id.clone());
                }
                Inline::Emphasis { children }
                | Inline::Strong { children }
                | Inline::Link { children, .. }
                | Inline::CrossReference { children, .. } => visit_inlines(children, ids),
                _ => {}
            }
        }
    }
    fn visit_blocks(blocks: &[Block], ids: &mut BTreeSet<String>) {
        for block in blocks {
            match block {
                Block::Heading { children, .. } | Block::Paragraph { children } => {
                    visit_inlines(children, ids);
                }
                Block::Quote { children } | Block::Callout { children, .. } => {
                    visit_blocks(children, ids);
                }
                Block::List { items, .. } => {
                    for item in items {
                        visit_blocks(&item.blocks, ids);
                    }
                }
                Block::Media {
                    label, asset_id, ..
                } => {
                    ids.insert(asset_id.clone());
                    visit_inlines(label, ids);
                }
                Block::Diagram { label, .. }
                | Block::Chart { label, .. }
                | Block::Attachment { label, .. } => visit_inlines(label, ids),
                _ => {}
            }
        }
    }

    let mut ids = BTreeSet::new();
    visit_blocks(&document.blocks, &mut ids);
    for blocks in document.footnotes.values() {
        visit_blocks(blocks, &mut ids);
    }
    ids
}

fn allowed_embedded_media_type(kind: &str, media_type: &str) -> bool {
    match kind {
        "image" => matches!(
            media_type,
            "image/png" | "image/jpeg" | "image/webp" | "image/avif" | "image/svg+xml"
        ),
        "audio" => matches!(
            media_type,
            "audio/ogg" | "audio/mpeg" | "audio/wav" | "audio/mp4"
        ),
        "video" => matches!(media_type, "video/webm" | "video/mp4" | "video/quicktime"),
        _ => false,
    }
}

fn embedded_media_priority(media_type: &str) -> usize {
    match media_type {
        "image/avif" => 0,
        "image/webp" => 1,
        "image/png" => 2,
        "image/jpeg" => 3,
        "image/svg+xml" => 4,
        "video/webm" | "audio/ogg" => 0,
        "video/mp4" | "audio/mp4" => 1,
        "audio/mpeg" => 2,
        "audio/wav" | "video/quicktime" => 3,
        _ => usize::MAX,
    }
}

fn safe_embedded_payload(media_type: &str, data: &[u8]) -> bool {
    match media_type {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP",
        "image/avif" => {
            data.len() >= 12
                && &data[4..8] == b"ftyp"
                && (&data[8..12] == b"avif" || &data[8..12] == b"avis")
        }
        "image/svg+xml" => safe_static_svg(data),
        "audio/ogg" => data.starts_with(b"OggS"),
        "audio/mpeg" => {
            data.starts_with(b"ID3")
                || data
                    .get(..2)
                    .is_some_and(|prefix| prefix[0] == 0xff && prefix[1] & 0xe0 == 0xe0)
        }
        "audio/wav" => data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WAVE",
        "audio/mp4" | "video/mp4" | "video/quicktime" => data.len() >= 12 && &data[4..8] == b"ftyp",
        "video/webm" => data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        _ => false,
    }
}

fn safe_static_svg(data: &[u8]) -> bool {
    let Ok(source) = std::str::from_utf8(data) else {
        return false;
    };
    if source.contains(['\0', '&', '\\']) {
        return false;
    }
    let mut body = source.trim_start_matches('\u{feff}').trim_start();
    if body.starts_with("<?xml") {
        let Some((_, rest)) = body.split_once("?>") else {
            return false;
        };
        body = rest.trim_start();
    }
    let lower = body.to_ascii_lowercase();
    let Some(root_tail) = lower.strip_prefix("<svg") else {
        return false;
    };
    if !root_tail
        .chars()
        .next()
        .is_some_and(|character| character.is_whitespace() || character == '>')
    {
        return false;
    }
    for marker in [
        "<!doctype",
        "<!entity",
        "<?",
        "<script",
        "<foreignobject",
        "<iframe",
        "<object",
        "<embed",
        "<audio",
        "<video",
        "<image",
        "<use",
        "<a ",
        "<style",
        "<animate",
        "<set",
        "<discard",
        "style=",
        "href=",
        "xlink:href",
        "url(",
        "@import",
        "javascript:",
        "data:",
        "file:",
        "blob:",
        "onabort",
        "onactivate",
        "onbegin",
        "onclick",
        "onend",
        "onerror",
        "onfocus",
        "onload",
        "onrepeat",
        "onresize",
        "onscroll",
        "onunload",
        "onzoom",
    ] {
        if lower.contains(marker) {
            return false;
        }
    }
    let compact = lower
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    for marker in [
        "style=",
        "href=",
        "xlink:href=",
        "url(",
        "javascript:",
        "data:",
        "file:",
        "blob:",
    ] {
        if compact.contains(marker) {
            return false;
        }
    }
    let external_check = lower
        .replace("http://www.w3.org/2000/svg", "")
        .replace("https://www.w3.org/2000/svg", "")
        .replace("http://www.w3.org/1999/xlink", "")
        .replace("https://www.w3.org/1999/xlink", "");
    !external_check.contains("http://")
        && !external_check.contains("https://")
        && !external_check.contains("//")
}

fn base64_encode(data: &[u8]) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(DIGITS[(first >> 2) as usize] as char);
        output.push(DIGITS[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(DIGITS[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(DIGITS[(third & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn html_embed_loss(report: &mut LossReport, asset_id: &str, reason: &str) {
    report.warning(
        "NMD-E103",
        format!("Asset {asset_id:?} was not embedded because {reason}."),
        None,
        Some(format!("asset:{asset_id}")),
        "A safe static placeholder is emitted and the package remains authoritative.",
    );
}

fn html_asset(output: &mut String, report: &mut LossReport, asset: HtmlAssetRender<'_>) {
    if let Some(embedded_asset) = asset.embedded.get(asset.asset_id) {
        match asset.kind {
            "image" if allowed_embedded_media_type("image", &embedded_asset.media_type) => {
                let escaped_alt = if asset.decorative {
                    String::new()
                } else {
                    html_escape(asset.plain_label)
                };
                output.push_str(&format!(
                    "<figure class=\"asset embedded-image\"><img src=\"{}\" alt=\"{}\"{}><figcaption>{}</figcaption></figure>",
                    embedded_asset.data_url,
                    escaped_alt,
                    if asset.decorative { " aria-hidden=true" } else { "" },
                    asset.label
                ));
                return;
            }
            "audio" if allowed_embedded_media_type("audio", &embedded_asset.media_type) => {
                output.push_str(&format!(
                    "<figure class=\"asset embedded-audio\"><audio controls preload=metadata src=\"{}\">Audio: {}</audio><figcaption>{}</figcaption></figure>",
                    embedded_asset.data_url,
                    html_escape(asset.plain_label),
                    asset.label
                ));
                return;
            }
            "video" if allowed_embedded_media_type("video", &embedded_asset.media_type) => {
                output.push_str(&format!(
                    "<figure class=\"asset embedded-video\"><video controls preload=metadata src=\"{}\">Video: {}</video><figcaption>{}</figcaption></figure>",
                    embedded_asset.data_url,
                    html_escape(asset.plain_label),
                    asset.label
                ));
                return;
            }
            _ => {}
        }
    }
    output.push_str(&format!(
        "<figure class=asset><div class=asset-placeholder><span>{}</span><code>asset:{}</code></div><figcaption>{}</figcaption></figure>",
        html_escape(asset.kind),
        html_escape(asset.asset_id),
        asset.label
    ));
    html_asset_loss(report, asset.path, asset.asset_id, asset.manifest);
}

fn html_asset_loss(
    report: &mut LossReport,
    path: &str,
    asset_id: &str,
    manifest: Option<&Manifest>,
) {
    let detail = manifest
        .and_then(|manifest| manifest.assets.get(asset_id))
        .and_then(|asset| asset.representations.first())
        .map(|representation| {
            format!(
                " ({}; {} bytes)",
                representation.media_type, representation.bytes
            )
        })
        .unwrap_or_default();
    report.warning(
        "NMD-E100",
        format!("Asset {asset_id:?}{detail} is represented by a safe static placeholder."),
        None,
        Some(path.into()),
        "The HTML remains one offline, script-free file with no external dependencies.",
    );
}

fn bounded_text(path: &Path) -> Result<String, CompatError> {
    let metadata = fs::metadata(path).map_err(op)?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(CompatError::Format(format!(
            "Input exceeds the {MAX_INPUT_BYTES}-byte limit."
        )));
    }
    let bytes = fs::read(path).map_err(op)?;
    let mut source = String::from_utf8(bytes)
        .map_err(|_| CompatError::Format("Markdown input must be UTF-8.".into()))?;
    if source.contains('\0') {
        return Err(CompatError::Format("Markdown input contains NUL.".into()));
    }
    source = source.replace("\r\n", "\n").replace('\r', "\n");
    if source.lines().count() > MAX_LINES {
        return Err(CompatError::Format(format!(
            "Input exceeds the {MAX_LINES}-line limit."
        )));
    }
    Ok(source)
}

fn heading(line: &str) -> Option<(u8, &str)> {
    let count = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&count) {
        return None;
    }
    if line.len() == count {
        return Some((count as u8, ""));
    }
    if line.as_bytes().get(count) != Some(&b' ') {
        return None;
    }
    let mut text = line[count + 1..].trim_end();
    let before_hashes = text.trim_end_matches('#');
    if before_hashes.len() < text.len() && before_hashes.ends_with(' ') {
        text = before_hashes.trim_end();
    }
    Some((count as u8, text))
}

fn thematic(line: &str) -> bool {
    let compact: String = line.chars().filter(|character| *character != ' ').collect();
    let Some(marker) = compact.chars().next() else {
        return false;
    };
    compact.len() >= 3
        && matches!(marker, '-' | '*' | '_')
        && compact.chars().all(|character| character == marker)
}

fn fence_open(line: &str) -> Option<(char, usize, Option<String>)> {
    let marker = line.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let count = line
        .chars()
        .take_while(|character| *character == marker)
        .count();
    if count < 3 {
        return None;
    }
    let info = line[count..].trim();
    if info.contains(['`', '~', ' ', '\t']) {
        return None;
    }
    Some((marker, count, (!info.is_empty()).then(|| info.into())))
}

fn fence_close(line: &str, marker: char, count: usize) -> bool {
    line.chars().count() >= count && line.chars().all(|character| character == marker)
}

fn list_marker(line: &str) -> Option<(bool, usize, &str)> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(text) = line.strip_prefix(marker) {
            return Some((false, 1, text));
        }
    }
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 9 || line.as_bytes().get(digits..digits + 2) != Some(b". ") {
        return None;
    }
    Some((true, line[..digits].parse().ok()?, &line[digits + 2..]))
}

fn starts_block(line: &str) -> bool {
    let line = line.trim_end();
    line.is_empty()
        || heading(line).is_some()
        || thematic(line)
        || fence_open(line).is_some()
        || line.starts_with('>')
        || list_marker(line).is_some()
}

fn join_lines(lines: &[&str]) -> String {
    let mut output = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        if let Some(line) = line.strip_suffix("  ") {
            output.push_str(line);
            output.push('\\');
        } else {
            output.push_str(line);
        }
    }
    output
}

fn setext(line: &str) -> bool {
    let line = line.trim();
    !line.is_empty()
        && (line.chars().all(|character| character == '=')
            || line.chars().all(|character| character == '-'))
}

fn table_rule(line: &str) -> bool {
    let cells: Vec<_> = line.trim().trim_matches('|').split('|').collect();
    cells.len() >= 2
        && cells.iter().all(|cell| {
            let cell = cell.trim().trim_matches(':');
            cell.len() >= 3 && cell.chars().all(|character| character == '-')
        })
}

fn link_definition(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('[') else {
        return false;
    };
    rest.find("]: ").is_some() || rest.find("]:").is_some()
}

fn link_parts(source: &str, image: bool) -> Option<(&str, &str, usize)> {
    let label_start = if image { 2 } else { 1 };
    let label_end = source[label_start..].find(']')? + label_start;
    if source.as_bytes().get(label_end + 1) != Some(&b'(') {
        return None;
    }
    let target_start = label_end + 2;
    let target_end = source[target_start..].find(')')? + target_start;
    Some((
        &source[label_start..label_end],
        &source[target_start..target_end],
        target_end + 1,
    ))
}

fn clean_target(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(value)
}

fn is_drawio_svg_path(value: &str) -> bool {
    value.to_ascii_lowercase().ends_with(".drawio.svg")
}

fn is_drawio_source_path(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.ends_with(".drawio") || value.ends_with(".dio") || value.ends_with(".drawio.svg")
}

fn inline_plain(nodes: &[Inline]) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } | Inline::Code { text } => output.push_str(text),
            Inline::Emphasis { children }
            | Inline::Strong { children }
            | Inline::Link { children, .. }
            | Inline::CrossReference { children, .. } => output.push_str(&inline_plain(children)),
            Inline::Image { alt, .. } => output.push_str(alt),
            Inline::HardBreak => output.push(' '),
            Inline::FootnoteReference { target } => output.push_str(target),
            Inline::MathInline { source, .. } => output.push_str(source),
        }
    }
    output
}

fn previous_is_alphanumeric(source: &str, cursor: usize) -> bool {
    source[..cursor]
        .chars()
        .next_back()
        .is_some_and(char::is_alphanumeric)
}

fn next_is_alphanumeric(tail: &str, index: usize) -> bool {
    tail[index..]
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric)
}

fn valid_https(value: &str) -> bool {
    value
        .strip_prefix("https://")
        .is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'))
        && !value.chars().any(char::is_whitespace)
}

fn entity(tail: &str) -> bool {
    tail.strip_prefix('&')
        .and_then(|rest| rest.find(';').map(|end| &rest[..end]))
        .is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 32
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '#')
        })
}

fn push_text(output: &mut Vec<Inline>, value: &str) {
    if let Some(Inline::Text { text }) = output.last_mut() {
        text.push_str(value);
    } else {
        output.push(Inline::Text { text: value.into() });
    }
}

fn escape_nmt(value: &str) -> String {
    escape_chars(value, r#"\*_`[]()#!{}$>-."#)
}

fn escape_markdown(value: &str) -> String {
    escape_chars(value, r#"\*_`[]<>#"#)
}

fn markdown_fence(text: &str) -> String {
    let mut longest = 0_usize;
    let mut current = 0_usize;
    for character in text.chars() {
        if character == '`' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    "`".repeat(3_usize.max(longest.saturating_add(1)))
}

fn safe_markdown_info(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
}

fn escape_chars(value: &str, special: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if special.contains(character) {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

fn reference(value: &Reference) -> String {
    match value {
        Reference::Internal { id } => format!("#{id}"),
        Reference::Asset { id } => format!("asset:{id}"),
        Reference::External { uri } => uri.clone(),
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn scalar(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        value => value.to_string(),
    }
}

fn callout_name(kind: CalloutKind) -> &'static str {
    match kind {
        CalloutKind::Note => "Note",
        CalloutKind::Tip => "Tip",
        CalloutKind::Warning => "Warning",
        CalloutKind::Danger => "Danger",
    }
}

fn media_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

fn required(args: &mut Vec<String>, name: &str) -> Result<String, CompatError> {
    option(args, name)?.ok_or_else(|| CompatError::Usage(format!("Missing {name}.")))
}

fn flag(args: &mut Vec<String>, name: &str) -> Result<bool, CompatError> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(false);
    };
    args.remove(index);
    if args.iter().any(|argument| argument == name) {
        return Err(CompatError::Usage(format!(
            "Flag {name} may be provided only once."
        )));
    }
    Ok(true)
}

fn option(args: &mut Vec<String>, name: &str) -> Result<Option<String>, CompatError> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    if index + 1 >= args.len() {
        return Err(CompatError::Usage(format!("Missing value for {name}.")));
    }
    let value = args.remove(index + 1);
    args.remove(index);
    Ok(Some(value))
}

fn reject_extra(args: &[String]) -> Result<(), CompatError> {
    if let Some(argument) = args.first() {
        Err(CompatError::Usage(format!(
            "Unexpected argument {argument}."
        )))
    } else {
        Ok(())
    }
}

fn extension(path: &Path) -> Option<&str> {
    path.extension().and_then(|value| value.to_str())
}

fn preflight(output: &Path, report: Option<&Path>) -> Result<(), CompatError> {
    if report == Some(output) {
        return Err(CompatError::Usage(
            "--output and --loss-report must be different.".into(),
        ));
    }
    for path in [Some(output), report].into_iter().flatten() {
        if path.exists() {
            return Err(CompatError::Operational(format!(
                "Refusing to overwrite {}.",
                path.display()
            )));
        }
    }
    Ok(())
}

fn write_new(path: &Path, value: &str) -> Result<(), CompatError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(op)?;
    file.write_all(value.as_bytes()).map_err(op)?;
    file.sync_all().map_err(op)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), CompatError> {
    let mut json = serde_json::to_string_pretty(value).map_err(op)?;
    json.push('\n');
    write_new(path, &json)
}

fn emit(report: &LossReport) {
    for item in &report.items {
        eprintln!(
            "{}{} {}",
            item.code,
            item.line
                .map(|line| format!(" line {line}"))
                .unwrap_or_default(),
            item.message
        );
        if let Some(fallback) = &item.fallback {
            eprintln!("  fallback: {fallback}");
        }
    }
    if report.truncated {
        eprintln!(
            "NMD-REPORT-LIMIT only the first {MAX_REPORT_ITEMS} diagnostics are shown; counts remain complete"
        );
    }
}

fn absolute(path: &Path) -> Result<PathBuf, CompatError> {
    if path.is_absolute() {
        Ok(path.into())
    } else {
        env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(op)
    }
}

fn op(error: impl std::fmt::Display) -> CompatError {
    CompatError::Operational(error.to_string())
}

const HTML_STYLE: &str = r#"
:root{color-scheme:light dark;--paper:#fbfaf6;--ink:#191817;--muted:#66615b;--line:#ddd8cf;--accent:#6941c6}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.65 ui-serif,Georgia,serif}main{width:min(74ch,calc(100% - 2rem));margin:4rem auto 8rem}h1,h2,h3,h4,h5,h6{line-height:1.15;margin:2em 0 .6em;font-family:ui-sans-serif,system-ui,sans-serif}h1{font-size:clamp(2.4rem,7vw,4.8rem)}a{color:var(--accent)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{overflow:auto;padding:1rem;border:1px solid var(--line);border-radius:.5rem}blockquote{margin:2rem 0;padding:.25rem 0 .25rem 1.25rem;border-left:.25rem solid var(--accent);color:var(--muted)}.metadata{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;padding:1rem;border:1px solid var(--line);border-radius:.5rem;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.85rem}.metadata dt{font-weight:700}.metadata dd{margin:0}.toc,.callout,.asset{margin:2rem 0;padding:1.25rem;border:1px solid var(--line);border-radius:.75rem}.callout{border-left:.35rem solid var(--accent)}.asset-placeholder{min-height:9rem;display:grid;place-content:center;gap:.5rem;text-align:center;background:color-mix(in srgb,var(--accent) 8%,transparent);border-radius:.4rem;text-transform:capitalize}.asset-placeholder code,.asset-ref{color:var(--muted);text-transform:none}.inline-image{display:inline-flex;max-width:100%;height:auto;padding:.1rem .45rem;border:1px solid var(--line);border-radius:.3rem}.embedded-image img,.embedded-video video{display:block;max-width:100%;height:auto;margin:auto}.embedded-audio audio{width:100%}.footnotes{margin-top:5rem;padding-top:1rem;border-top:1px solid var(--line)}@media(prefers-color-scheme:dark){:root{--paper:#171614;--ink:#f4f1eb;--muted:#b8b1a8;--line:#3d3934;--accent:#b79cff}}@media(max-width:600px){body{font-size:16px}main{margin-top:2rem}}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subset_roundtrips_through_nmt_parser() {
        let mut report = LossReport::new(
            "import",
            Path::new("in.md"),
            Path::new("out.nmt"),
            Some("commonmark"),
        );
        let cwd = env::current_dir().expect("cwd");
        let mut importer = Importer::new(&cwd, &mut report);
        let document = importer.document(
            "# Title\n\nA *small* **strong** snake_case [link](https://example.test).\n\n> Quote.\n\n3. Three\n4. Four\n\n```rust\nfn main() {}\n```\n",
        );
        assert!(!report.has_errors(), "{:#?}", report.items);
        assert_eq!(document.blocks.len(), 5);
        let source = to_nmt(&document).expect("source");
        assert!(parse(&source).is_valid(), "{source}");
        assert!(source.contains("3. Three\n1. Four"));
        assert!(source.contains("snake\\_case"));
    }

    #[test]
    fn ambiguous_extensions_fail_visibly() {
        let mut report = LossReport::new(
            "import",
            Path::new("in.md"),
            Path::new("out.nmt"),
            Some("github"),
        );
        let cwd = env::current_dir().expect("cwd");
        let mut importer = Importer::new(&cwd, &mut report);
        let _ = importer.document("| A | B |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n");
        assert!(report.has_errors());
        assert!(report.items.iter().any(|item| item.code == "NMD-I051"));
        assert!(report.items.iter().any(|item| item.code == "NMD-I102"));
    }

    #[test]
    fn html_is_script_free_and_escapes_text() {
        let document = Document {
            model_version: "0.1".into(),
            metadata: BTreeMap::new(),
            blocks: vec![Block::Paragraph {
                children: vec![Inline::Text {
                    text: "<script>alert(1)</script>".into(),
                }],
            }],
            footnotes: BTreeMap::new(),
        };
        let mut report =
            LossReport::new("export", Path::new("in.nmt"), Path::new("out.html"), None);
        let html = to_html(&document, None, None, &mut report);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("src=\"http"));
        assert!(html.contains("default-src 'none'"));
        assert!(html.contains("script-src 'none'"));
        assert!(html.contains("connect-src 'none'"));
        assert!(html.contains("name=referrer content=no-referrer"));
    }

    #[test]
    fn markdown_export_chooses_a_non_colliding_fence_and_reports_bad_info() {
        let document = Document {
            model_version: "0.1".into(),
            metadata: BTreeMap::new(),
            blocks: vec![Block::CodeBlock {
                language: Some("bad token`".into()),
                text: "before\n``````\nafter".into(),
            }],
            footnotes: BTreeMap::new(),
        };
        let mut report = LossReport::new("export", Path::new("in.nmt"), Path::new("out.md"), None);
        let markdown = to_markdown(&document, &mut report);
        assert!(markdown.starts_with("```````\nbefore"));
        assert!(markdown.ends_with("after\n```````\n"));
        assert!(report.items.iter().any(|item| item.code == "NMD-E025"));
    }

    #[test]
    fn html_media_preflight_accepts_signatures_and_rejects_active_svg() {
        assert_eq!(base64_encode(b"NotMarkdown"), "Tm90TWFya2Rvd24=");
        assert!(safe_embedded_payload(
            "image/png",
            b"\x89PNG\r\n\x1a\nfixture"
        ));
        assert!(safe_static_svg(
            br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>"##
        ));
        for unsafe_svg in [
            br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg" onload = "alert(1)"></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href = "https://example.test/a.png"/></svg>"#.as_slice(),
            br#"<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.test/x.css)</style></svg>"#.as_slice(),
        ] {
            assert!(!safe_static_svg(unsafe_svg));
        }
    }

    #[test]
    fn portable_migration_keys_reject_platform_traps_and_unicode_drift() {
        assert_eq!(
            portable_relative_path_key(Path::new("Guide/ReadMe.nmdoc")).expect("portable key"),
            portable_relative_path_key(Path::new("guide/readme.nmdoc")).expect("folded key")
        );
        assert_eq!(
            portable_relative_path_key(Path::new("Ｆoo.nmdoc")).expect("compatibility key"),
            portable_relative_path_key(Path::new("foo.nmdoc")).expect("ASCII key")
        );
        assert_eq!(
            portable_relative_path_key(Path::new("Straße.nmdoc")).expect("full fold key"),
            portable_relative_path_key(Path::new("STRASSE.nmdoc")).expect("expanded fold key")
        );
        assert!(portable_relative_path_key(Path::new("Cafe\u{301}.nmdoc")).is_err());
        for invalid in [
            "CON.nmdoc",
            "prn.txt",
            "aux",
            "NUL.data",
            "COM1.nmdoc",
            "lpt9.anything",
            "bad?.nmdoc",
            "bad:name.nmdoc",
            "trailing.",
            "trailing ",
        ] {
            assert!(
                portable_relative_path_key(Path::new(invalid)).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn static_visual_html_uses_escaped_fallbacks_and_explicit_losses() {
        let document = Document {
            model_version: "0.1".into(),
            metadata: BTreeMap::new(),
            blocks: vec![
                Block::CodeBlock {
                    language: Some("mermaid".into()),
                    text: "flowchart LR\nA[<script>] --> B".into(),
                },
                Block::CodeBlock {
                    language: Some("vega-lite".into()),
                    text: r#"{"data":{"values":[{"x":"A","y":1}]},"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}"#.into(),
                },
            ],
            footnotes: BTreeMap::new(),
        };
        let mut report =
            LossReport::new("export", Path::new("in.nmt"), Path::new("out.html"), None);
        let html = to_html(&document, None, None, &mut report);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("Mermaid source · static fallback"));
        assert!(html.contains("Vega-Lite source · static fallback"));
        assert!(report.items.iter().any(|item| item.code == "NMD-E104"));
        assert!(report.items.iter().any(|item| item.code == "NMD-E105"));
    }

    #[test]
    fn markdown_import_adopts_drawio_svg_and_plain_source() {
        let directory =
            env::temp_dir().join(format!("notmarkdown-drawio-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create fixture directory");
        fs::write(
            directory.join("architecture.drawio.svg"),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>"#,
        )
        .expect("write draw.io SVG");
        fs::write(directory.join("editable.drawio"), b"<mxfile></mxfile>")
            .expect("write draw.io source");
        let canonical_directory = directory
            .canonicalize()
            .expect("canonical fixture directory");

        let mut report = LossReport::new(
            "import",
            &directory.join("in.md"),
            &directory.join("out.nmdoc"),
            Some("github"),
        );
        let (document, assets) = {
            let mut importer = Importer::new(&canonical_directory, &mut report);
            let document = importer.document(
                "![Architecture](architecture.drawio.svg)\n\n[Editable source](editable.drawio)\n",
            );
            (document, importer.assets)
        };
        assert!(!report.has_errors(), "{:#?}", report.items);
        assert!(matches!(&document.blocks[0], Block::Diagram { .. }));
        assert_eq!(assets.len(), 2);
        assert!(assets.iter().all(|asset| asset.kind == "diagram"));
        let generated = to_nmt(&document).expect("serialize imported document");
        assert!(generated.contains("!diagram[Architecture] {"));
        assert!(parse(&generated).is_valid(), "{generated}");
        assert!(report.items.iter().any(|item| item.code == "NMD-I211"));
        assert!(report.items.iter().any(|item| item.code == "NMD-I212"));
        fs::remove_dir_all(directory).expect("remove fixture directory");
    }
}
