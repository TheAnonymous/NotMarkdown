//! Local Compatibility Kit: bounded Markdown conversion and Git integration.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
};

use notmarkdown_core::{
    Block, CalloutKind, Document, FigureAttributes, Inline, ListItem, MediaKind, Reference,
    RenderableNotation, parse, preflight_static_visual, renderable_notation, to_cdm_value,
};
use notmarkdown_package::{AssetInput, ContainerProfile, Manifest, create_package, open};
use serde::Serialize;
use serde_json::Value;

const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINES: usize = 100_000;
const MAX_BLOCKS: usize = 100_000;
const MAX_INLINE_DEPTH: usize = 16;
const MAX_ASSETS: usize = 512;
const MAX_REPORT_ITEMS: usize = 4096;

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
    let profile = match option(&mut args, "--profile")?
        .as_deref()
        .unwrap_or("portable")
    {
        "portable" | "portable-0.1" => ContainerProfile::Portable,
        "modern" | "modern-0.1" => ContainerProfile::Modern,
        value => return Err(CompatError::Usage(format!("Unknown profile {value}."))),
    };
    reject_extra(&args)?;
    preflight(&output, report_path.as_deref())?;

    let source = bounded_text(&input)?;
    let base = input
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .canonicalize()
        .map_err(op)?;
    let mut report = LossReport::new("import", &input, &output, Some(&dialect));
    let (document, assets) = {
        let mut importer = Importer::new(&base, &mut report);
        let document = importer.document(&source);
        (document, importer.assets)
    };
    if report.has_errors() {
        emit(&report);
        if let Some(path) = report_path.as_deref() {
            write_json(path, &report)?;
        }
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
        write_new(&output, &nmt)?;
    } else {
        create_package(&nmt, &assets, profile, &output)
            .map_err(|error| CompatError::Operational(error.to_string()))?;
    }
    if let Some(path) = report_path.as_deref() {
        write_json(path, &report)?;
    } else {
        emit(&report);
    }
    println!("{}", absolute(&output)?.display());
    Ok(0)
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
    let loaded = load(&input)?;
    let mut report = LossReport::new("export", &input, &output, None);
    let rendered = if target == "markdown" {
        to_markdown(&loaded.document, &mut report)
    } else {
        to_html(&loaded.document, loaded.manifest.as_ref(), &mut report)
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
                if let Some(source_asset) =
                    self.local_asset(destination, line_no, &["diagram"])
                {
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
        let destination = clean_target(destination);
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
}

fn load(path: &Path) -> Result<Loaded, CompatError> {
    if extension(path) == Some("nmdoc") {
        let package = open(path).map_err(|error| CompatError::Format(error.to_string()))?;
        Ok(Loaded {
            document: package.document,
            manifest: Some(package.manifest),
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
                let fence = if text.lines().any(|line| line == "```") {
                    "````"
                } else {
                    "```"
                };
                output.push_str(fence);
                output.push_str(language.as_deref().unwrap_or(""));
                output.push('\n');
                output.push_str(text);
                output.push('\n');
                output.push_str(fence);
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

fn to_html(document: &Document, manifest: Option<&Manifest>, report: &mut LossReport) -> String {
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
    html_blocks(&document.blocks, &mut body, report, manifest, "");
    if !document.footnotes.is_empty() {
        body.push_str("<section class=footnotes aria-label=Footnotes><h2>Footnotes</h2><ol>");
        for (id, blocks) in &document.footnotes {
            body.push_str(&format!("<li id=\"fn-{}\">", html_escape(id)));
            html_blocks(
                blocks,
                &mut body,
                report,
                manifest,
                "/definitions/footnotes",
            );
            body.push_str("</li>");
        }
        body.push_str("</ol></section>");
    }
    format!(
        "<!doctype html>\n<html lang=\"{}\"><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'\"><meta name=generator content=\"NotMarkdown Compatibility Kit 0.1\"><title>{}</title><style>{}</style></head><body><main>{}</main></body></html>\n",
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
                output.push_str(&html_inlines(children, report, manifest, &path));
                output.push_str(&format!("</h{level}>"));
            }
            Block::Paragraph { children } => {
                output.push_str("<p>");
                output.push_str(&html_inlines(children, report, manifest, &path));
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
                            output.push_str(&html_inlines(children, report, manifest, &path));
                            output.push_str("</a>");
                        } else {
                            output.push_str(&html_inlines(children, report, manifest, &path));
                        }
                        output.push_str("</li>");
                    }
                }
                output.push_str("</ol></nav>");
            }
            Block::Quote { children } => {
                output.push_str("<blockquote>");
                html_blocks(children, output, report, manifest, &path);
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
                    html_blocks(&item.blocks, output, report, manifest, &path);
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
                        output.push_str(&format!(
                            " data-language=\"{}\"",
                            html_escape(language)
                        ));
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
                html_blocks(children, output, report, manifest, &path);
                output.push_str("</aside>");
            }
            Block::Media {
                kind,
                label,
                asset_id,
                attributes,
                decorative,
            } => {
                let label = html_inlines(label, report, manifest, &path);
                html_asset(
                    output,
                    report,
                    manifest,
                    &path,
                    media_name(*kind),
                    asset_id,
                    &label,
                );
                if *kind != MediaKind::Image
                    || *decorative
                    || attributes != &notmarkdown_core::MediaAttributes::default()
                {
                    report.warning(
                        "NMD-E101",
                        "Media playback, layout, and auxiliary relationships are inert in static HTML.",
                        None,
                        Some(path),
                        "Kind, label, asset ID, and representation metadata remain visible.",
                    );
                }
            }
            Block::Diagram {
                diagram_type,
                label,
                source_asset,
            } => {
                let label = html_inlines(label, report, manifest, &path);
                html_asset(
                    output,
                    report,
                    manifest,
                    &path,
                    &format!("diagram · {diagram_type}"),
                    source_asset,
                    &label,
                );
            }
            Block::Chart {
                chart_type,
                label,
                data_asset,
            } => {
                let label = html_inlines(label, report, manifest, &path);
                html_asset(
                    output,
                    report,
                    manifest,
                    &path,
                    &format!("chart · {chart_type}"),
                    data_asset,
                    &label,
                );
            }
            Block::MathBlock { notation, source } => output.push_str(&format!(
                "<figure class=math><pre>{}</pre><figcaption>Math ({})</figcaption></figure>",
                html_escape(source),
                html_escape(notation)
            )),
            Block::Attachment { label, asset_id } => {
                let label = html_inlines(label, report, manifest, &path);
                html_asset(
                    output,
                    report,
                    manifest,
                    &path,
                    "attachment",
                    asset_id,
                    &label,
                );
            }
        }
    }
}

fn html_inlines(
    nodes: &[Inline],
    report: &mut LossReport,
    manifest: Option<&Manifest>,
    path: &str,
) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } => output.push_str(&html_escape(text)),
            Inline::Emphasis { children } => output.push_str(&format!(
                "<em>{}</em>",
                html_inlines(children, report, manifest, path)
            )),
            Inline::Strong { children } => output.push_str(&format!(
                "<strong>{}</strong>",
                html_inlines(children, report, manifest, path)
            )),
            Inline::Code { text } => {
                output.push_str(&format!("<code>{}</code>", html_escape(text)));
            }
            Inline::Link { target, children } => {
                let label = html_inlines(children, report, manifest, path);
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
                if *decorative {
                    output.push_str("<span class=\"asset inline-image\" aria-hidden=true>Decorative image</span>");
                } else {
                    output.push_str(&format!(
                        "<span class=\"asset inline-image\" role=img aria-label=\"{}\">Image · {}</span>",
                        html_escape(alt),
                        html_escape(alt)
                    ));
                }
                html_asset_loss(report, path, asset_id, manifest);
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
                html_inlines(children, report, manifest, path)
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

fn html_asset(
    output: &mut String,
    report: &mut LossReport,
    manifest: Option<&Manifest>,
    path: &str,
    kind: &str,
    asset_id: &str,
    label: &str,
) {
    output.push_str(&format!(
        "<figure class=asset><div class=asset-placeholder><span>{}</span><code>asset:{}</code></div><figcaption>{}</figcaption></figure>",
        html_escape(kind),
        html_escape(asset_id),
        label
    ));
    html_asset_loss(report, path, asset_id, manifest);
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
:root{color-scheme:light dark;--paper:#fbfaf6;--ink:#191817;--muted:#66615b;--line:#ddd8cf;--accent:#6941c6}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.65 ui-serif,Georgia,serif}main{width:min(74ch,calc(100% - 2rem));margin:4rem auto 8rem}h1,h2,h3,h4,h5,h6{line-height:1.15;margin:2em 0 .6em;font-family:ui-sans-serif,system-ui,sans-serif}h1{font-size:clamp(2.4rem,7vw,4.8rem)}a{color:var(--accent)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{overflow:auto;padding:1rem;border:1px solid var(--line);border-radius:.5rem}blockquote{margin:2rem 0;padding:.25rem 0 .25rem 1.25rem;border-left:.25rem solid var(--accent);color:var(--muted)}.metadata{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;padding:1rem;border:1px solid var(--line);border-radius:.5rem;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.85rem}.metadata dt{font-weight:700}.metadata dd{margin:0}.toc,.callout,.asset{margin:2rem 0;padding:1.25rem;border:1px solid var(--line);border-radius:.75rem}.callout{border-left:.35rem solid var(--accent)}.asset-placeholder{min-height:9rem;display:grid;place-content:center;gap:.5rem;text-align:center;background:color-mix(in srgb,var(--accent) 8%,transparent);border-radius:.4rem;text-transform:capitalize}.asset-placeholder code,.asset-ref{color:var(--muted);text-transform:none}.inline-image{display:inline-flex;padding:.1rem .45rem;border:1px solid var(--line);border-radius:.3rem}.footnotes{margin-top:5rem;padding-top:1rem;border-top:1px solid var(--line)}@media(prefers-color-scheme:dark){:root{--paper:#171614;--ink:#f4f1eb;--muted:#b8b1a8;--line:#3d3934;--accent:#b79cff}}@media(max-width:600px){body{font-size:16px}main{margin-top:2rem}}
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
        let html = to_html(&document, None, &mut report);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("src=\"http"));
        assert!(html.contains("default-src 'none'"));
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
        let html = to_html(&document, None, &mut report);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("Mermaid source · static fallback"));
        assert!(html.contains("Vega-Lite source · static fallback"));
        assert!(report.items.iter().any(|item| item.code == "NMD-E104"));
        assert!(report.items.iter().any(|item| item.code == "NMD-E105"));
    }

    #[test]
    fn markdown_import_adopts_drawio_svg_and_plain_source() {
        let directory = env::temp_dir().join(format!(
            "notmarkdown-drawio-import-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create fixture directory");
        fs::write(
            directory.join("architecture.drawio.svg"),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>"#,
        )
        .expect("write draw.io SVG");
        fs::write(directory.join("editable.drawio"), b"<mxfile></mxfile>")
            .expect("write draw.io source");

        let mut report = LossReport::new(
            "import",
            &directory.join("in.md"),
            &directory.join("out.nmdoc"),
            Some("github"),
        );
        let (document, assets) = {
            let mut importer = Importer::new(&directory, &mut report);
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
