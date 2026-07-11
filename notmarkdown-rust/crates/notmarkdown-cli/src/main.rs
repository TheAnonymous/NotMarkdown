use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};

use notmarkdown_core::{
    Document, OutlineEntry, SearchHit, SearchIndex, build_search_index, outline, parse,
    search_index, to_cdm_json, to_cdm_value,
};
use notmarkdown_package::{
    AssetInput, ContainerProfile, EntryInfo, Manifest, PackageError, build_package_search_index,
    create_package, extract_all, open, verify_all,
};
use serde::Serialize;
use serde_json::Value;

mod compat;

const MAX_DOCUMENT_CHANGES: usize = 256;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(CliError::Usage(message)) => {
            if !message.is_empty() {
                eprintln!("{message}\n");
            }
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
        Err(CliError::Format(message)) => {
            eprintln!("NMD_FORMAT {message}");
            ExitCode::from(1)
        }
        Err(CliError::Operational(message)) => {
            eprintln!("NMD_CLI {message}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<u8, CliError> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let Some(command) = args.first().cloned() else {
        return Err(CliError::Usage(String::new()));
    };
    args.remove(0);
    match command.as_str() {
        "parse" => parse_command(args),
        "outline" => outline_command(args),
        "index" => index_command(args),
        "search" => search_command(args),
        "pack" => pack_command(args),
        "unpack" => unpack_command(args),
        "inspect" => inspect_command(args),
        "verify" => verify_command(args),
        "diff" => diff_command(args),
        "import" => compat::import_command(args).map_err(compat_error),
        "export" => compat::export_command(args).map_err(compat_error),
        "git" => compat::git_command(args).map_err(compat_error),
        "--version" | "-V" => {
            if !args.is_empty() {
                return Err(CliError::Usage("--version takes no arguments.".into()));
            }
            println!("notmarkdown {}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
        "--help" | "-h" | "help" => {
            if !args.is_empty() {
                return Err(CliError::Usage("help takes no arguments.".into()));
            }
            println!("{}", usage());
            Ok(0)
        }
        _ => Err(CliError::Usage(format!("Unknown command {command}."))),
    }
}

fn outline_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    if args.len() != 1 {
        return Err(CliError::Usage(
            "outline requires exactly one .nmt or .nmdoc path.".into(),
        ));
    }
    let document = load_semantic(Path::new(&args[0]))?.document;
    print_json(
        &OutlineReport {
            entries: outline(&document),
        },
        compact,
    )?;
    Ok(0)
}

fn index_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    if args.len() != 1 {
        return Err(CliError::Usage(
            "index requires exactly one .nmt or .nmdoc path.".into(),
        ));
    }
    let index = load_search_index(Path::new(&args[0]))?;
    print_json(&index, compact)?;
    Ok(0)
}

fn search_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    let raw_limit = take_option(&mut args, "--limit")?.unwrap_or_else(|| "20".into());
    let limit: usize = raw_limit
        .parse()
        .ok()
        .filter(|value| (1..=100).contains(value))
        .ok_or_else(|| CliError::Usage("--limit must be an integer from 1 through 100.".into()))?;
    if args.len() != 2 {
        return Err(CliError::Usage(
            "search requires a document path and one quoted query.".into(),
        ));
    }
    let index = load_search_index(Path::new(&args[0]))?;
    let query = args[1].clone();
    print_json(
        &SearchReport {
            query: &query,
            hits: search_index(&index, &query, limit),
        },
        compact,
    )?;
    Ok(0)
}

fn parse_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    if args.len() != 1 {
        return Err(CliError::Usage(
            "parse requires exactly one document.nmt path.".into(),
        ));
    }
    let path = PathBuf::from(args.remove(0));
    let source = read_text(&path)?;
    let parsed = parse(&source);
    let Some(document) = parsed.document else {
        print_diagnostics(&path, &parsed.diagnostics);
        return Ok(1);
    };
    println!("{}", to_cdm_json(&document, !compact).map_err(operational)?);
    Ok(0)
}

fn pack_command(mut args: Vec<String>) -> Result<u8, CliError> {
    if args.is_empty() {
        return Err(CliError::Usage("pack requires a document.nmt path.".into()));
    }
    let input = PathBuf::from(args.remove(0));
    let output = take_option(&mut args, "--output")?
        .map(PathBuf::from)
        .unwrap_or_else(|| input.with_extension("nmdoc"));
    let profile = match take_option(&mut args, "--profile")?
        .as_deref()
        .unwrap_or("modern")
    {
        "modern" | "modern-0.1" => ContainerProfile::Modern,
        "portable" | "portable-0.1" => ContainerProfile::Portable,
        value => {
            return Err(CliError::Usage(format!(
                "Unknown container profile {value}."
            )));
        }
    };
    let mappings = take_repeated_option(&mut args, "--asset")?;
    if !args.is_empty() {
        return Err(CliError::Usage(format!("Unexpected argument {}.", args[0])));
    }

    let source = read_text(&input)?;
    let mut assets = Vec::with_capacity(mappings.len());
    for mapping in mappings {
        let (id, path) = mapping
            .split_once('=')
            .ok_or_else(|| CliError::Usage("Asset mappings use --asset id=path.".into()))?;
        if id.is_empty() || path.is_empty() {
            return Err(CliError::Usage(
                "Asset mappings use --asset id=path.".into(),
            ));
        }
        assets.push(AssetInput::from_path(id, path).map_err(package_error)?);
    }
    let created = create_package(&source, &assets, profile, &output).map_err(package_error)?;
    println!("{}", created.display());
    Ok(0)
}

fn unpack_command(mut args: Vec<String>) -> Result<u8, CliError> {
    if args.is_empty() {
        return Err(CliError::Usage(
            "unpack requires a document.nmdoc path.".into(),
        ));
    }
    let input = PathBuf::from(args.remove(0));
    let output = take_option(&mut args, "--output")?
        .map(PathBuf::from)
        .ok_or_else(|| CliError::Usage("unpack requires --output directory.".into()))?;
    if !args.is_empty() {
        return Err(CliError::Usage(format!("Unexpected argument {}.", args[0])));
    }
    let package = open(&input).map_err(package_error)?;
    extract_all(&package, &output).map_err(package_error)?;
    println!("{}", absolute_path(&output)?.display());
    Ok(0)
}

fn inspect_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    if args.len() != 1 {
        return Err(CliError::Usage(
            "inspect requires exactly one document.nmdoc path.".into(),
        ));
    }
    let package = open(PathBuf::from(args.remove(0))).map_err(package_error)?;
    let inspection = Inspection {
        manifest: &package.manifest,
        entries: &package.entries,
        validation: ValidationSummary {
            structure: "verified",
            source: "verified",
            representations: "deferred",
            deferred_representations: package.deferred_representations,
        },
    };
    print_json(&inspection, compact)?;
    Ok(0)
}

fn verify_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    if args.len() != 1 {
        return Err(CliError::Usage(
            "verify requires exactly one document.nmdoc path.".into(),
        ));
    }
    let package = open(PathBuf::from(args.remove(0))).map_err(package_error)?;
    let representations = verify_all(&package).map_err(package_error)?;
    print_json(
        &VerificationReport {
            status: "verified",
            representations,
        },
        compact,
    )?;
    Ok(0)
}

fn diff_command(mut args: Vec<String>) -> Result<u8, CliError> {
    let compact = take_flag(&mut args, "--compact");
    if args.len() != 2 {
        return Err(CliError::Usage(
            "diff requires two .nmt or .nmdoc paths.".into(),
        ));
    }
    let left = load_semantic(Path::new(&args[0]))?;
    let right = load_semantic(Path::new(&args[1]))?;
    let report = semantic_diff(&left, &right)?;
    let code = u8::from(!report.equal);
    print_json(&report, compact)?;
    Ok(code)
}

#[derive(Serialize)]
struct Inspection<'a> {
    manifest: &'a Manifest,
    entries: &'a [EntryInfo],
    validation: ValidationSummary<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationSummary<'a> {
    structure: &'a str,
    source: &'a str,
    representations: &'a str,
    deferred_representations: usize,
}

#[derive(Serialize)]
struct VerificationReport<'a> {
    status: &'a str,
    representations: usize,
}

#[derive(Serialize)]
struct OutlineReport {
    entries: Vec<OutlineEntry>,
}

#[derive(Serialize)]
struct SearchReport<'a> {
    query: &'a str,
    hits: Vec<SearchHit>,
}

struct SemanticInput {
    document: Document,
    assets: Option<BTreeMap<String, AssetFingerprint>>,
}

fn load_search_index(path: &Path) -> Result<SearchIndex, CliError> {
    if path.extension().and_then(|value| value.to_str()) == Some("nmdoc") {
        let package = open(path).map_err(package_error)?;
        build_package_search_index(&package).map_err(package_error)
    } else {
        Ok(build_search_index(&load_semantic(path)?.document))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct AssetFingerprint {
    kind: String,
    representations: Vec<RepresentationFingerprint>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepresentationFingerprint {
    role: String,
    media_type: String,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffReport {
    equal: bool,
    document_equal: bool,
    document_changes: Vec<JsonChange>,
    document_changes_truncated: bool,
    assets: AssetDiff,
}

#[derive(Serialize)]
struct JsonChange {
    path: String,
    kind: ChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ChangeKind {
    Added,
    Removed,
    Changed,
}

#[derive(Serialize)]
struct AssetDiff {
    compared: bool,
    added: Vec<String>,
    removed: Vec<String>,
    changed: Vec<String>,
}

fn load_semantic(path: &Path) -> Result<SemanticInput, CliError> {
    if path.extension().and_then(|value| value.to_str()) == Some("nmdoc") {
        let package = open(path).map_err(package_error)?;
        let assets = package
            .manifest
            .assets
            .into_iter()
            .map(|(id, asset)| {
                let mut representations: Vec<_> = asset
                    .representations
                    .into_iter()
                    .map(|representation| RepresentationFingerprint {
                        role: representation.role,
                        media_type: representation.media_type,
                        bytes: representation.bytes,
                        sha256: representation.sha256,
                    })
                    .collect();
                representations.sort();
                (
                    id,
                    AssetFingerprint {
                        kind: asset.kind,
                        representations,
                    },
                )
            })
            .collect();
        Ok(SemanticInput {
            document: package.document,
            assets: Some(assets),
        })
    } else {
        let source = read_text(path)?;
        let parsed = parse(&source);
        let document = parsed.document.ok_or_else(|| {
            let message = parsed
                .diagnostics
                .first()
                .map(|item| format!("{}: {}", item.code, item.message))
                .unwrap_or_else(|| "invalid source".into());
            CliError::Format(format!("{}: {message}", path.display()))
        })?;
        Ok(SemanticInput {
            document,
            assets: None,
        })
    }
}

fn semantic_diff(left: &SemanticInput, right: &SemanticInput) -> Result<DiffReport, CliError> {
    let left_document = to_cdm_value(&left.document).map_err(operational)?;
    let right_document = to_cdm_value(&right.document).map_err(operational)?;
    let document_equal = left_document == right_document;
    let mut document_changes = Vec::new();
    let mut truncated = false;
    diff_values(
        &left_document,
        &right_document,
        "",
        &mut document_changes,
        &mut truncated,
    );

    let assets = match (&left.assets, &right.assets) {
        (Some(left), Some(right)) => {
            let left_ids: BTreeSet<_> = left.keys().cloned().collect();
            let right_ids: BTreeSet<_> = right.keys().cloned().collect();
            let added = right_ids.difference(&left_ids).cloned().collect();
            let removed = left_ids.difference(&right_ids).cloned().collect();
            let changed = left_ids
                .intersection(&right_ids)
                .filter(|id| left.get(*id) != right.get(*id))
                .cloned()
                .collect();
            AssetDiff {
                compared: true,
                added,
                removed,
                changed,
            }
        }
        _ => AssetDiff {
            compared: false,
            added: Vec::new(),
            removed: Vec::new(),
            changed: Vec::new(),
        },
    };
    let assets_equal = !assets.compared
        || (assets.added.is_empty() && assets.removed.is_empty() && assets.changed.is_empty());
    Ok(DiffReport {
        equal: document_equal && assets_equal,
        document_equal,
        document_changes,
        document_changes_truncated: truncated,
        assets,
    })
}

fn diff_values(
    left: &Value,
    right: &Value,
    path: &str,
    changes: &mut Vec<JsonChange>,
    truncated: &mut bool,
) {
    if left == right {
        return;
    }
    if changes.len() >= MAX_DOCUMENT_CHANGES {
        *truncated = true;
        return;
    }
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            let keys: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
            for key in keys {
                let child = pointer(path, &escape_pointer(&key));
                match (left.get(&key), right.get(&key)) {
                    (Some(before), Some(after)) => {
                        diff_values(before, after, &child, changes, truncated);
                    }
                    (None, Some(after)) => push_change(
                        changes,
                        truncated,
                        JsonChange {
                            path: child,
                            kind: ChangeKind::Added,
                            before: None,
                            after: Some(after.clone()),
                        },
                    ),
                    (Some(before), None) => push_change(
                        changes,
                        truncated,
                        JsonChange {
                            path: child,
                            kind: ChangeKind::Removed,
                            before: Some(before.clone()),
                            after: None,
                        },
                    ),
                    (None, None) => unreachable!(),
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            for index in 0..left.len().max(right.len()) {
                let child = pointer(path, &index.to_string());
                match (left.get(index), right.get(index)) {
                    (Some(before), Some(after)) => {
                        diff_values(before, after, &child, changes, truncated);
                    }
                    (None, Some(after)) => push_change(
                        changes,
                        truncated,
                        JsonChange {
                            path: child,
                            kind: ChangeKind::Added,
                            before: None,
                            after: Some(after.clone()),
                        },
                    ),
                    (Some(before), None) => push_change(
                        changes,
                        truncated,
                        JsonChange {
                            path: child,
                            kind: ChangeKind::Removed,
                            before: Some(before.clone()),
                            after: None,
                        },
                    ),
                    (None, None) => unreachable!(),
                }
            }
        }
        _ => push_change(
            changes,
            truncated,
            JsonChange {
                path: if path.is_empty() {
                    "/".into()
                } else {
                    path.into()
                },
                kind: ChangeKind::Changed,
                before: Some(left.clone()),
                after: Some(right.clone()),
            },
        ),
    }
}

fn push_change(changes: &mut Vec<JsonChange>, truncated: &mut bool, change: JsonChange) {
    if changes.len() < MAX_DOCUMENT_CHANGES {
        changes.push(change);
    } else {
        *truncated = true;
    }
}

fn pointer(parent: &str, child: &str) -> String {
    format!("{parent}/{child}")
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn print_diagnostics(path: &Path, diagnostics: &[notmarkdown_core::Diagnostic]) {
    for diagnostic in diagnostics {
        eprintln!(
            "{}:{}:{} {} {}",
            path.display(),
            diagnostic.line,
            diagnostic.column,
            diagnostic.code,
            diagnostic.message
        );
        if let Some(suggestion) = &diagnostic.suggestion {
            eprintln!("  suggestion: {suggestion}");
        }
    }
}

fn print_json(value: &impl Serialize, compact: bool) -> Result<(), CliError> {
    let json = if compact {
        serde_json::to_string(value)
    } else {
        serde_json::to_string_pretty(value)
    }
    .map_err(operational)?;
    println!("{json}");
    Ok(())
}

fn read_text(path: &Path) -> Result<String, CliError> {
    fs::read_to_string(path)
        .map_err(|error| CliError::Operational(format!("{}: {error}", path.display())))
}

fn absolute_path(path: &Path) -> Result<PathBuf, CliError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(operational)
    }
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return false;
    };
    args.remove(index);
    true
}

fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>, CliError> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    if index + 1 >= args.len() {
        return Err(CliError::Usage(format!("Missing value for {name}.")));
    }
    let value = args.remove(index + 1);
    args.remove(index);
    Ok(Some(value))
}

fn take_repeated_option(args: &mut Vec<String>, name: &str) -> Result<Vec<String>, CliError> {
    let mut values = Vec::new();
    while let Some(value) = take_option(args, name)? {
        values.push(value);
    }
    Ok(values)
}

fn package_error(error: PackageError) -> CliError {
    match error {
        PackageError::Format(message) => CliError::Format(message),
        other => CliError::Operational(other.to_string()),
    }
}

fn operational(error: impl fmt::Display) -> CliError {
    CliError::Operational(error.to_string())
}

fn compat_error(error: compat::CompatError) -> CliError {
    match error {
        compat::CompatError::Usage(message) => CliError::Usage(message),
        compat::CompatError::Format(message) => CliError::Format(message),
        compat::CompatError::Operational(message) => CliError::Operational(message),
    }
}

#[derive(Debug)]
enum CliError {
    Usage(String),
    Format(String),
    Operational(String),
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) | Self::Format(message) | Self::Operational(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl Error for CliError {}

fn usage() -> &'static str {
    "Usage:\n  notmarkdown parse [--compact] document.nmt\n  notmarkdown outline [--compact] document.nmt|document.nmdoc\n  notmarkdown index [--compact] document.nmt|document.nmdoc\n  notmarkdown search [--compact] [--limit 20] document query\n  notmarkdown pack document.nmt [--output file.nmdoc]\n      [--profile modern|portable] [--asset id=path]...\n  notmarkdown unpack document.nmdoc --output directory\n  notmarkdown inspect [--compact] document.nmdoc\n  notmarkdown verify [--compact] document.nmdoc\n  notmarkdown diff [--compact] left.nmt|left.nmdoc right.nmt|right.nmdoc\n  notmarkdown import input.md --dialect commonmark|github --to nmt|nmdoc\n      --output PATH [--loss-report PATH] [--profile portable|modern]\n  notmarkdown import input-directory --recursive --dialect commonmark|github\n      --to nmt|nmdoc --output DIRECTORY [--loss-report PATH]\n      [--profile portable|modern]\n      (bounded Compatibility Kit 0.1 subset; not full CommonMark/GFM)\n  notmarkdown export input.nmt|input.nmdoc --to markdown|html\n      --output PATH [--loss-report PATH]\n  notmarkdown git install [--local REPOSITORY]\n  notmarkdown git textconv document.nmt|document.nmdoc\n  notmarkdown git source document.nmt|document.nmdoc"
}
