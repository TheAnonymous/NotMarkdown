//! Canonical document types, a strict 0.1 parser slice, and terminal rendering.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

use serde::{
    Deserialize, Serialize,
    ser::{SerializeMap, SerializeSeq, SerializeStruct},
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Document {
    pub model_version: String,
    pub metadata: BTreeMap<String, Value>,
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub footnotes: BTreeMap<String, Vec<Block>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Heading {
        level: u8,
        children: Vec<Inline>,
        id: Option<String>,
    },
    Paragraph {
        children: Vec<Inline>,
    },
    ThematicBreak,
    TableOfContents {
        max_depth: Option<u8>,
    },
    Quote {
        children: Vec<Block>,
    },
    List {
        ordered: bool,
        start: usize,
        items: Vec<ListItem>,
    },
    CodeBlock {
        language: Option<String>,
        text: String,
    },
    Callout {
        kind: CalloutKind,
        children: Vec<Block>,
    },
    Media {
        kind: MediaKind,
        label: Vec<Inline>,
        asset_id: String,
        attributes: MediaAttributes,
        decorative: bool,
    },
    Diagram {
        diagram_type: String,
        label: Vec<Inline>,
        source_asset: String,
    },
    Chart {
        chart_type: String,
        label: Vec<Inline>,
        data_asset: String,
    },
    MathBlock {
        notation: String,
        source: String,
    },
    Attachment {
        label: Vec<Inline>,
        asset_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inline {
    Text {
        text: String,
    },
    Emphasis {
        children: Vec<Inline>,
    },
    Strong {
        children: Vec<Inline>,
    },
    Code {
        text: String,
    },
    Link {
        target: Reference,
        children: Vec<Inline>,
    },
    Image {
        asset_id: String,
        alt: String,
        attributes: FigureAttributes,
        decorative: bool,
    },
    HardBreak,
    FootnoteReference {
        target: String,
    },
    CrossReference {
        target: String,
        children: Vec<Inline>,
    },
    MathInline {
        source: String,
        notation: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Reference {
    Internal { id: String },
    Asset { id: String },
    External { uri: String },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FigureAttributes {
    pub layout: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaAttributes {
    pub layout: Option<String>,
    pub poster: Option<String>,
    pub transcript: Option<String>,
    pub chapters: Option<String>,
    pub start: Option<String>,
    pub captions: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListItem {
    pub checked: Option<bool>,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalloutKind {
    Note,
    Tip,
    Warning,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Audio,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub suggestion: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub level: u8,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndex {
    pub index_version: String,
    pub document_model_version: String,
    pub entries: Vec<SearchEntry>,
    pub omissions: Vec<SearchOmission>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_path: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_path: Option<String>,
    pub context: String,
    pub score: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOmission {
    pub asset_id: String,
    pub package_path: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchAsset {
    pub id: String,
    pub package_path: String,
    pub media_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedSearchAsset {
    pub id: String,
    pub package_path: String,
    pub media_type: String,
    pub fingerprint: String,
    pub bytes: usize,
    pub data: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCacheStats {
    pub generation: u64,
    pub document_reused: bool,
    pub assets_reused: usize,
    pub assets_reindexed: usize,
    pub assets_removed: usize,
    pub entries: usize,
    pub omissions: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchCacheUpdate {
    pub index: SearchIndex,
    pub stats: SearchCacheStats,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchCacheMiss {
    pub asset_id: String,
    pub package_path: String,
}

impl fmt::Display for SearchCacheMiss {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Search cache needs bytes for asset {} at {}.",
            self.asset_id, self.package_path
        )
    }
}

impl Error for SearchCacheMiss {}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CachedAssetText {
    Text(String),
    Omission(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CachedAssetEntry {
    fingerprint: String,
    media_type: String,
    value: CachedAssetText,
}

#[derive(Clone, Debug, Default)]
pub struct IncrementalSearchCache {
    document_fingerprint: Option<String>,
    document_index: Option<SearchIndex>,
    assets: BTreeMap<String, CachedAssetEntry>,
    generation: u64,
}

pub const MAX_SEARCH_ASSET_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TOTAL_SEARCH_ASSET_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_STATIC_VISUAL_BYTES: usize = 256 * 1024;
pub const MAX_STATIC_VISUAL_LINES: usize = 10_000;

/// Declarative visual notations which an adapter may render in a sealed,
/// static preview. Detection is deliberately case-sensitive so that ordinary
/// code fences never silently change meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderableNotation {
    Mermaid,
    VegaLite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaticVisualErrorKind {
    UnsupportedNotation,
    SizeLimit,
    LineLimit,
    InvalidSyntax,
    UnsafeFeature,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaticVisualError {
    pub kind: StaticVisualErrorKind,
    pub message: String,
}

impl fmt::Display for StaticVisualError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for StaticVisualError {}

/// Return the renderable notation for an exact fenced-code language token.
/// `vegalite` is the sole compatibility alias; broad aliases such as `vl` are
/// intentionally not recognized.
pub fn renderable_notation(language: &str) -> Option<RenderableNotation> {
    match language {
        "mermaid" => Some(RenderableNotation::Mermaid),
        "vega-lite" | "vegalite" => Some(RenderableNotation::VegaLite),
        _ => None,
    }
}

/// Validate a declarative visual before a renderer sees it. This function does
/// not render or execute anything; adapters must still keep the resulting SVG
/// behind a non-scriptable image boundary.
pub fn preflight_static_visual(
    language: &str,
    source: &str,
) -> Result<RenderableNotation, StaticVisualError> {
    let notation = renderable_notation(language).ok_or_else(|| visual_error(
        StaticVisualErrorKind::UnsupportedNotation,
        "Only exact mermaid, vega-lite, and vegalite fence tokens are renderable.",
    ))?;
    match notation {
        RenderableNotation::Mermaid => preflight_mermaid(source)?,
        RenderableNotation::VegaLite => preflight_vega_lite(source, None)?,
    }
    Ok(notation)
}

/// Conservative Mermaid preflight for offline, static previews. Mermaid is
/// still treated as inert source by the parser; this merely admits a bounded
/// subset to a renderer selected by the caller.
pub fn preflight_mermaid(source: &str) -> Result<(), StaticVisualError> {
    preflight_visual_bounds(source)?;
    let trimmed = source.trim_start_matches('\u{feff}').trim_start();
    if trimmed.is_empty() {
        return Err(visual_error(
            StaticVisualErrorKind::InvalidSyntax,
            "Mermaid source is empty.",
        ));
    }
    if trimmed.starts_with("---\n") || trimmed.starts_with("---\r\n") {
        return Err(visual_error(
            StaticVisualErrorKind::UnsafeFeature,
            "Mermaid front matter and configuration are disabled.",
        ));
    }

    let lower = trimmed.to_ascii_lowercase();
    for marker in [
        "%%{",
        "securitylevel",
        "themevariables",
        "javascript:",
        "https://",
        "http://",
        "file:",
        "data:",
        "blob:",
        "url(",
        "image(",
        "image-set(",
        "@import",
        "@font-face",
        "<script",
        "<iframe",
        "<object",
        "<embed",
        "<img",
        "<svg",
        "src=",
        "href=",
        "xlink:href",
        "](",
    ] {
        if lower.contains(marker) {
            return Err(visual_error(
                StaticVisualErrorKind::UnsafeFeature,
                "Mermaid configuration, markup, links, and external resources are disabled.",
            ));
        }
    }
    for line in lower.lines().map(str::trim_start) {
        if line.starts_with("click ")
            || line.starts_with("href ")
            || line.starts_with("callback ")
            || line.starts_with("call ")
            || line.starts_with("link ")
            || line.starts_with("links ")
            || line.starts_with("icon:")
            || line.starts_with("image:")
            || line.contains(" icon:")
            || line.contains(" image:")
        {
            return Err(visual_error(
                StaticVisualErrorKind::UnsafeFeature,
                "Mermaid interactions and resource-bearing shapes are disabled.",
            ));
        }
    }

    let header = trimmed
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("%%"))
        .unwrap_or_default();
    let keyword = header.split_ascii_whitespace().next().unwrap_or_default();
    if !matches!(
        keyword,
        "flowchart"
            | "graph"
            | "sequenceDiagram"
            | "classDiagram"
            | "stateDiagram"
            | "stateDiagram-v2"
            | "erDiagram"
            | "journey"
            | "gantt"
            | "pie"
            | "quadrantChart"
            | "requirementDiagram"
            | "gitGraph"
            | "mindmap"
            | "timeline"
            | "zenuml"
            | "sankey-beta"
            | "xychart-beta"
            | "block-beta"
            | "packet-beta"
            | "kanban"
            | "architecture-beta"
            | "radar-beta"
            | "treemap-beta"
    ) {
        return Err(visual_error(
            StaticVisualErrorKind::InvalidSyntax,
            "Mermaid source must start with a supported diagram declaration.",
        ));
    }
    Ok(())
}

/// Validate the deliberately small Vega-Lite values-only chart subset. When a
/// native NotMarkdown chart type is supplied, its semantic type must match the
/// Vega-Lite mark.
pub fn preflight_vega_lite(
    source: &str,
    chart_type: Option<&str>,
) -> Result<(), StaticVisualError> {
    preflight_visual_bounds(source)?;
    let value: Value = serde_json::from_str(source).map_err(|_| {
        visual_error(
            StaticVisualErrorKind::InvalidSyntax,
            "Vega-Lite source must be valid JSON.",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        visual_error(
            StaticVisualErrorKind::InvalidSyntax,
            "Vega-Lite source must be a JSON object.",
        )
    })?;
    reject_unknown_keys(
        object,
        &[
            "$schema",
            "title",
            "description",
            "data",
            "mark",
            "encoding",
            "width",
            "height",
        ],
        "Vega-Lite top level",
    )?;

    if let Some(schema) = object.get("$schema") {
        let Some(schema) = schema.as_str() else {
            return Err(invalid_vega("$schema must be a string."));
        };
        if !matches!(
            schema,
            "https://vega.github.io/schema/vega-lite/v5.json"
                | "https://vega.github.io/schema/vega-lite/v6.json"
        ) {
            return Err(invalid_vega("Only Vega-Lite v5 and v6 schema identifiers are accepted."));
        }
    }
    for key in ["title", "description"] {
        if let Some(value) = object.get(key) {
            bounded_string(value, key, 4096)?;
        }
    }
    for key in ["width", "height"] {
        if let Some(value) = object.get(key) {
            let Some(value) = value.as_u64() else {
                return Err(invalid_vega(&format!("{key} must be an integer.")));
            };
            if !(1..=4096).contains(&value) {
                return Err(invalid_vega(&format!("{key} must be between 1 and 4096.")));
            }
        }
    }

    let data = object
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_vega("data.values is required."))?;
    reject_unknown_keys(data, &["values"], "Vega-Lite data")?;
    let values = data
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_vega("data.values must be an array."))?;
    if values.len() > 10_000 {
        return Err(invalid_vega("data.values exceeds 10,000 records."));
    }
    for row in values {
        let row = row
            .as_object()
            .ok_or_else(|| invalid_vega("Every data.values record must be an object."))?;
        if row.len() > 128 {
            return Err(invalid_vega("A data.values record exceeds 128 fields."));
        }
        for (field, value) in row {
            if field.is_empty() || field.len() > 256 || !is_scalar(value) {
                return Err(invalid_vega(
                    "Data field names must be bounded and record values must be scalar.",
                ));
            }
        }
    }

    let mark = object
        .get("mark")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_vega("mark must be a supported string."))?;
    if !matches!(mark, "bar" | "line" | "area" | "point" | "circle" | "arc") {
        return Err(invalid_vega("Unsupported Vega-Lite mark."));
    }
    if let Some(chart_type) = chart_type {
        let matches_type = match chart_type {
            "bar" => mark == "bar",
            "line" => mark == "line",
            "area" => mark == "area",
            "scatter" => matches!(mark, "point" | "circle"),
            "pie" => mark == "arc",
            _ => false,
        };
        if !matches_type {
            return Err(invalid_vega(
                "The native chart type does not match the Vega-Lite mark.",
            ));
        }
    }

    let encoding = object
        .get("encoding")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_vega("encoding must be an object."))?;
    if encoding.is_empty() || encoding.len() > 24 {
        return Err(invalid_vega("encoding must contain between 1 and 24 channels."));
    }
    for (channel, definition) in encoding {
        if !matches!(
            channel.as_str(),
            "x" | "x2"
                | "y"
                | "y2"
                | "theta"
                | "theta2"
                | "radius"
                | "radius2"
                | "color"
                | "fill"
                | "stroke"
                | "size"
                | "shape"
                | "opacity"
                | "detail"
                | "order"
                | "text"
                | "tooltip"
        ) {
            return Err(invalid_vega("Unsupported Vega-Lite encoding channel."));
        }
        validate_field_definition(definition)?;
    }
    Ok(())
}

fn preflight_visual_bounds(source: &str) -> Result<(), StaticVisualError> {
    if source.len() > MAX_STATIC_VISUAL_BYTES {
        return Err(visual_error(
            StaticVisualErrorKind::SizeLimit,
            "Static visual source exceeds the 256 KiB limit.",
        ));
    }
    if source.bytes().filter(|byte| *byte == b'\n').count() + 1 > MAX_STATIC_VISUAL_LINES {
        return Err(visual_error(
            StaticVisualErrorKind::LineLimit,
            "Static visual source exceeds the 10,000-line limit.",
        ));
    }
    if source.contains('\0') {
        return Err(visual_error(
            StaticVisualErrorKind::InvalidSyntax,
            "Static visual source cannot contain NUL.",
        ));
    }
    Ok(())
}

fn validate_field_definition(value: &Value) -> Result<(), StaticVisualError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_vega("Encoding definitions must be objects."))?;
    reject_unknown_keys(
        object,
        &[
            "field",
            "type",
            "aggregate",
            "bin",
            "timeUnit",
            "title",
            "sort",
            "stack",
            "scale",
            "axis",
            "legend",
            "value",
        ],
        "Vega-Lite field definition",
    )?;
    if !object.contains_key("field")
        && !object.contains_key("value")
        && object.get("aggregate").and_then(Value::as_str) != Some("count")
    {
        return Err(invalid_vega(
            "An encoding requires field, value, or aggregate=count.",
        ));
    }
    if let Some(field) = object.get("field") {
        bounded_string(field, "field", 256)?;
    }
    if let Some(kind) = object.get("type") {
        let kind = kind
            .as_str()
            .ok_or_else(|| invalid_vega("Encoding type must be a string."))?;
        if !matches!(kind, "quantitative" | "temporal" | "ordinal" | "nominal") {
            return Err(invalid_vega("Unsupported encoding type."));
        }
    }
    if let Some(aggregate) = object.get("aggregate") {
        let aggregate = aggregate
            .as_str()
            .ok_or_else(|| invalid_vega("aggregate must be a string."))?;
        if !matches!(
            aggregate,
            "count"
                | "sum"
                | "mean"
                | "median"
                | "min"
                | "max"
                | "distinct"
                | "valid"
                | "missing"
                | "q1"
                | "q3"
                | "stderr"
                | "stdev"
                | "stdevp"
                | "variance"
                | "variancep"
        ) {
            return Err(invalid_vega("Unsupported aggregate."));
        }
    }
    if let Some(bin) = object.get("bin")
        && !bin.is_boolean()
    {
        return Err(invalid_vega("bin must be a boolean."));
    }
    if let Some(time_unit) = object.get("timeUnit") {
        let time_unit = time_unit
            .as_str()
            .ok_or_else(|| invalid_vega("timeUnit must be a string."))?;
        if !matches!(
            time_unit,
            "year"
                | "quarter"
                | "month"
                | "week"
                | "day"
                | "dayofyear"
                | "date"
                | "hours"
                | "minutes"
                | "seconds"
                | "milliseconds"
                | "yearquarter"
                | "yearquartermonth"
                | "yearmonth"
                | "yearmonthdate"
                | "monthdate"
                | "hoursminutes"
                | "hoursminutesseconds"
                | "minutesseconds"
                | "secondsmilliseconds"
        ) {
            return Err(invalid_vega("Unsupported timeUnit."));
        }
    }
    if let Some(title) = object.get("title") {
        bounded_string(title, "encoding title", 1024)?;
    }
    if let Some(sort) = object.get("sort")
        && !sort.is_null()
        && !matches!(sort.as_str(), Some("ascending" | "descending"))
    {
        return Err(invalid_vega("sort must be ascending, descending, or null."));
    }
    if let Some(stack) = object.get("stack")
        && !stack.is_null()
        && !matches!(stack.as_str(), Some("zero" | "normalize" | "center"))
    {
        return Err(invalid_vega("stack must be zero, normalize, center, or null."));
    }
    if let Some(scale) = object.get("scale") {
        validate_scale(scale)?;
    }
    if let Some(axis) = object.get("axis") {
        validate_guide(axis, "axis")?;
    }
    if let Some(legend) = object.get("legend") {
        validate_guide(legend, "legend")?;
    }
    if let Some(value) = object.get("value")
        && !is_scalar(value)
    {
        return Err(invalid_vega("Encoding value must be scalar."));
    }
    Ok(())
}

fn validate_scale(value: &Value) -> Result<(), StaticVisualError> {
    if value.is_null() {
        return Ok(());
    }
    let object = value
        .as_object()
        .ok_or_else(|| invalid_vega("scale must be an object or null."))?;
    reject_unknown_keys(object, &["type", "zero", "nice", "reverse"], "Vega-Lite scale")?;
    if let Some(kind) = object.get("type") {
        let kind = kind
            .as_str()
            .ok_or_else(|| invalid_vega("scale.type must be a string."))?;
        if !matches!(
            kind,
            "linear"
                | "log"
                | "pow"
                | "sqrt"
                | "symlog"
                | "time"
                | "utc"
                | "ordinal"
                | "band"
                | "point"
        ) {
            return Err(invalid_vega("Unsupported scale type."));
        }
    }
    for key in ["zero", "nice", "reverse"] {
        if let Some(value) = object.get(key)
            && !value.is_boolean()
        {
            return Err(invalid_vega(&format!("scale.{key} must be a boolean.")));
        }
    }
    Ok(())
}

fn validate_guide(value: &Value, kind: &str) -> Result<(), StaticVisualError> {
    if value.is_null() {
        return Ok(());
    }
    let object = value
        .as_object()
        .ok_or_else(|| invalid_vega(&format!("{kind} must be an object or null.")))?;
    reject_unknown_keys(
        object,
        &["title", "grid", "labels", "ticks", "domain", "orient"],
        &format!("Vega-Lite {kind}"),
    )?;
    if let Some(title) = object.get("title") {
        bounded_string(title, &format!("{kind}.title"), 1024)?;
    }
    for key in ["grid", "labels", "ticks", "domain"] {
        if let Some(value) = object.get(key)
            && !value.is_boolean()
        {
            return Err(invalid_vega(&format!("{kind}.{key} must be a boolean.")));
        }
    }
    if let Some(orient) = object.get("orient") {
        let orient = orient
            .as_str()
            .ok_or_else(|| invalid_vega(&format!("{kind}.orient must be a string.")))?;
        if !matches!(orient, "top" | "bottom" | "left" | "right" | "none") {
            return Err(invalid_vega(&format!("Unsupported {kind}.orient.")));
        }
    }
    Ok(())
}

fn reject_unknown_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    context: &str,
) -> Result<(), StaticVisualError> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_vega(&format!(
            "{context} contains unsupported key {key:?}."
        )));
    }
    Ok(())
}

fn bounded_string(value: &Value, name: &str, limit: usize) -> Result<(), StaticVisualError> {
    let Some(value) = value.as_str() else {
        return Err(invalid_vega(&format!("{name} must be a string.")));
    };
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(invalid_vega(&format!("{name} is not a bounded plain string.")));
    }
    Ok(())
}

fn is_scalar(value: &Value) -> bool {
    value.is_null() || value.is_boolean() || value.is_number() || value.is_string()
}

fn invalid_vega(message: &str) -> StaticVisualError {
    visual_error(StaticVisualErrorKind::InvalidSyntax, message)
}

fn visual_error(kind: StaticVisualErrorKind, message: &str) -> StaticVisualError {
    StaticVisualError {
        kind,
        message: message.into(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParseResult {
    pub document: Option<Document>,
    pub diagnostics: Vec<Diagnostic>,
}

impl ParseResult {
    pub fn is_valid(&self) -> bool {
        self.document.is_some()
            && !self
                .diagnostics
                .iter()
                .any(|item| item.severity == Severity::Error)
    }
}

/// Serialize the implemented semantic model as normative NotMarkdown CDM JSON.
/// Internal Rust field and variant names are deliberately not exposed.
pub fn to_cdm_json(document: &Document, pretty: bool) -> Result<String, serde_json::Error> {
    if pretty {
        serde_json::to_string_pretty(&CdmDocument(document))
    } else {
        serde_json::to_string(&CdmDocument(document))
    }
}

/// Return the normative CDM as a JSON value for conformance tests and semantic
/// comparison.
pub fn to_cdm_value(document: &Document) -> Result<Value, serde_json::Error> {
    serde_json::to_value(CdmDocument(document))
}

struct CdmDocument<'a>(&'a Document);

impl Serialize for CdmDocument<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("Document", 5)?;
        state.serialize_field("type", "document")?;
        state.serialize_field("modelVersion", &self.0.model_version)?;
        state.serialize_field("metadata", &self.0.metadata)?;
        state.serialize_field("children", &CdmBlocks(&self.0.blocks))?;
        state.serialize_field("definitions", &CdmDefinitions(&self.0.footnotes))?;
        state.end()
    }
}

struct CdmDefinitions<'a>(&'a BTreeMap<String, Vec<Block>>);

impl Serialize for CdmDefinitions<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let empty = BTreeMap::<String, Value>::new();
        let mut state = serializer.serialize_struct("Definitions", 3)?;
        state.serialize_field("footnotes", &CdmFootnotes(self.0))?;
        state.serialize_field("citations", &empty)?;
        state.serialize_field("extensions", &empty)?;
        state.end()
    }
}

struct CdmFootnotes<'a>(&'a BTreeMap<String, Vec<Block>>);

impl Serialize for CdmFootnotes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (id, blocks) in self.0 {
            map.serialize_entry(id, &CdmBlocks(blocks))?;
        }
        map.end()
    }
}

struct CdmBlocks<'a>(&'a [Block]);

impl Serialize for CdmBlocks<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for block in self.0 {
            sequence.serialize_element(&CdmBlock(block))?;
        }
        sequence.end()
    }
}

struct CdmBlock<'a>(&'a Block);

impl Serialize for CdmBlock<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self.0 {
            Block::Heading {
                level,
                children,
                id,
            } => {
                let mut state = serializer.serialize_struct("Heading", 4)?;
                state.serialize_field("type", "heading")?;
                if let Some(id) = id {
                    state.serialize_field("id", id)?;
                }
                state.serialize_field("level", level)?;
                state.serialize_field("children", &CdmInlines(children))?;
                state.end()
            }
            Block::Paragraph { children } => {
                let mut state = serializer.serialize_struct("Paragraph", 2)?;
                state.serialize_field("type", "paragraph")?;
                state.serialize_field("children", &CdmInlines(children))?;
                state.end()
            }
            Block::ThematicBreak => {
                let mut state = serializer.serialize_struct("ThematicBreak", 1)?;
                state.serialize_field("type", "thematicBreak")?;
                state.end()
            }
            Block::TableOfContents { max_depth } => {
                let mut state = serializer.serialize_struct("TableOfContents", 2)?;
                state.serialize_field("type", "tableOfContents")?;
                if let Some(max_depth) = max_depth {
                    state.serialize_field("maxDepth", max_depth)?;
                }
                state.end()
            }
            Block::Quote { children } => {
                let mut state = serializer.serialize_struct("BlockQuote", 2)?;
                state.serialize_field("type", "blockQuote")?;
                state.serialize_field("children", &CdmBlocks(children))?;
                state.end()
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                let mut state = serializer.serialize_struct("List", 4)?;
                state.serialize_field("type", "list")?;
                state.serialize_field("ordered", ordered)?;
                if *ordered && *start != 1 {
                    state.serialize_field("start", start)?;
                }
                state.serialize_field("children", &CdmListItems(items))?;
                state.end()
            }
            Block::CodeBlock { language, text } => {
                let mut state = serializer.serialize_struct("CodeBlock", 3)?;
                state.serialize_field("type", "codeBlock")?;
                state.serialize_field("text", text)?;
                if let Some(language) = language {
                    state.serialize_field("language", language)?;
                }
                state.end()
            }
            Block::Callout { kind, children } => {
                let mut state = serializer.serialize_struct("Callout", 3)?;
                state.serialize_field("type", "callout")?;
                state.serialize_field("kind", kind)?;
                state.serialize_field("children", &CdmBlocks(children))?;
                state.end()
            }
            Block::Media {
                kind,
                label,
                asset_id,
                attributes,
                decorative,
            } => serialize_media(serializer, *kind, label, asset_id, attributes, *decorative),
            Block::Diagram {
                diagram_type,
                label,
                source_asset,
            } => {
                let mut state = serializer.serialize_struct("Diagram", 4)?;
                state.serialize_field("type", "diagram")?;
                state.serialize_field("diagramType", diagram_type)?;
                state.serialize_field("source", &AssetReference(source_asset))?;
                state.serialize_field("children", &CdmLabelBlocks(label))?;
                state.end()
            }
            Block::Chart {
                chart_type,
                label,
                data_asset,
            } => {
                let mut state = serializer.serialize_struct("Chart", 4)?;
                state.serialize_field("type", "chart")?;
                state.serialize_field("chartType", chart_type)?;
                state.serialize_field("data", &AssetReference(data_asset))?;
                state.serialize_field("children", &CdmLabelBlocks(label))?;
                state.end()
            }
            Block::MathBlock { notation, source } => {
                let mut state = serializer.serialize_struct("MathBlock", 3)?;
                state.serialize_field("type", "mathBlock")?;
                state.serialize_field("source", source)?;
                state.serialize_field("notation", notation)?;
                state.end()
            }
            Block::Attachment { label, asset_id } => {
                let mut state = serializer.serialize_struct("Attachment", 4)?;
                state.serialize_field("type", "attachment")?;
                state.serialize_field("resource", &AssetReference(asset_id))?;
                state.serialize_field("label", &CdmInlines(label))?;
                state.serialize_field("children", &EmptyArray)?;
                state.end()
            }
        }
    }
}

fn serialize_media<S>(
    serializer: S,
    kind: MediaKind,
    label: &[Inline],
    asset_id: &str,
    attributes: &MediaAttributes,
    decorative: bool,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if kind == MediaKind::Image {
        let mut state = serializer.serialize_struct("Figure", 6)?;
        state.serialize_field("type", "figure")?;
        state.serialize_field("resource", &AssetReference(asset_id))?;
        state.serialize_field("alt", &inline_plain(label))?;
        if decorative {
            state.serialize_field("decorative", &true)?;
        }
        if attributes.layout.is_some() {
            state.serialize_field("attributes", &CdmFigureAttributes(attributes))?;
        }
        state.serialize_field("children", &EmptyArray)?;
        return state.end();
    }

    let node_type = match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
        MediaKind::Image => unreachable!(),
    };
    let mut state = serializer.serialize_struct("Media", 5)?;
    state.serialize_field("type", node_type)?;
    state.serialize_field("resource", &AssetReference(asset_id))?;
    state.serialize_field("label", &CdmInlines(label))?;
    if !attributes.is_empty() {
        state.serialize_field("attributes", &CdmMediaAttributes(attributes))?;
    }
    state.serialize_field("children", &EmptyArray)?;
    state.end()
}

impl MediaAttributes {
    fn is_empty(&self) -> bool {
        self.layout.is_none()
            && self.poster.is_none()
            && self.transcript.is_none()
            && self.chapters.is_none()
            && self.start.is_none()
            && self.captions.is_empty()
    }
}

struct CdmListItems<'a>(&'a [ListItem]);

impl Serialize for CdmListItems<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for item in self.0 {
            sequence.serialize_element(&CdmListItem(item))?;
        }
        sequence.end()
    }
}

struct CdmListItem<'a>(&'a ListItem);

impl Serialize for CdmListItem<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("ListItem", 3)?;
        state.serialize_field("type", "listItem")?;
        if let Some(checked) = self.0.checked {
            state.serialize_field("checked", &checked)?;
        }
        state.serialize_field("children", &CdmBlocks(&self.0.blocks))?;
        state.end()
    }
}

struct CdmInlines<'a>(&'a [Inline]);

impl Serialize for CdmInlines<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for inline in self.0 {
            sequence.serialize_element(&CdmInline(inline))?;
        }
        sequence.end()
    }
}

struct CdmInline<'a>(&'a Inline);

impl Serialize for CdmInline<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self.0 {
            Inline::Text { text } => {
                let mut state = serializer.serialize_struct("Text", 2)?;
                state.serialize_field("type", "text")?;
                state.serialize_field("text", text)?;
                state.end()
            }
            Inline::Emphasis { children } => {
                serialize_inline_container(serializer, "emphasis", children)
            }
            Inline::Strong { children } => {
                serialize_inline_container(serializer, "strong", children)
            }
            Inline::Code { text } => {
                let mut state = serializer.serialize_struct("Code", 2)?;
                state.serialize_field("type", "code")?;
                state.serialize_field("text", text)?;
                state.end()
            }
            Inline::Link { target, children } => {
                let mut state = serializer.serialize_struct("Link", 3)?;
                state.serialize_field("type", "link")?;
                state.serialize_field("target", target)?;
                state.serialize_field("children", &CdmInlines(children))?;
                state.end()
            }
            Inline::Image {
                asset_id,
                alt,
                attributes,
                decorative,
            } => {
                let mut state = serializer.serialize_struct("Image", 5)?;
                state.serialize_field("type", "image")?;
                state.serialize_field("resource", &AssetReference(asset_id))?;
                state.serialize_field("alt", alt)?;
                if *decorative {
                    state.serialize_field("decorative", &true)?;
                }
                if attributes.layout.is_some() {
                    state.serialize_field("attributes", &CdmInlineFigureAttributes(attributes))?;
                }
                state.end()
            }
            Inline::HardBreak => {
                let mut state = serializer.serialize_struct("HardBreak", 1)?;
                state.serialize_field("type", "hardBreak")?;
                state.end()
            }
            Inline::FootnoteReference { target } => {
                let mut state = serializer.serialize_struct("FootnoteReference", 2)?;
                state.serialize_field("type", "footnoteReference")?;
                state.serialize_field("target", target)?;
                state.end()
            }
            Inline::CrossReference { target, children } => {
                let mut state = serializer.serialize_struct("CrossReference", 3)?;
                state.serialize_field("type", "crossReference")?;
                state.serialize_field("target", &InternalReference(target))?;
                state.serialize_field("children", &CdmInlines(children))?;
                state.end()
            }
            Inline::MathInline { source, notation } => {
                let mut state = serializer.serialize_struct("MathInline", 3)?;
                state.serialize_field("type", "mathInline")?;
                state.serialize_field("source", source)?;
                state.serialize_field("notation", notation)?;
                state.end()
            }
        }
    }
}

fn serialize_inline_container<S>(
    serializer: S,
    node_type: &'static str,
    children: &[Inline],
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut state = serializer.serialize_struct("InlineContainer", 2)?;
    state.serialize_field("type", node_type)?;
    state.serialize_field("children", &CdmInlines(children))?;
    state.end()
}

struct AssetReference<'a>(&'a str);

impl Serialize for AssetReference<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("AssetReference", 2)?;
        state.serialize_field("kind", "asset")?;
        state.serialize_field("id", self.0)?;
        state.end()
    }
}

struct InternalReference<'a>(&'a str);

impl Serialize for InternalReference<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("InternalReference", 2)?;
        state.serialize_field("kind", "internal")?;
        state.serialize_field("id", self.0)?;
        state.end()
    }
}

struct CdmFigureAttributes<'a>(&'a MediaAttributes);

impl Serialize for CdmFigureAttributes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("LayoutAttributes", 1)?;
        if let Some(layout) = &self.0.layout {
            state.serialize_field("layout", layout)?;
        }
        state.end()
    }
}

struct CdmInlineFigureAttributes<'a>(&'a FigureAttributes);

impl Serialize for CdmInlineFigureAttributes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("LayoutAttributes", 1)?;
        if let Some(layout) = &self.0.layout {
            state.serialize_field("layout", layout)?;
        }
        state.end()
    }
}

struct CdmMediaAttributes<'a>(&'a MediaAttributes);

impl Serialize for CdmMediaAttributes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let attributes = self.0;
        let mut state = serializer.serialize_struct("MediaAttributes", 6)?;
        if let Some(layout) = &attributes.layout {
            state.serialize_field("layout", layout)?;
        }
        if let Some(id) = &attributes.poster {
            state.serialize_field("poster", &AssetReference(id))?;
        }
        if let Some(id) = &attributes.transcript {
            state.serialize_field("transcript", &AssetReference(id))?;
        }
        if let Some(id) = &attributes.chapters {
            state.serialize_field("chapters", &AssetReference(id))?;
        }
        if let Some(start) = &attributes.start {
            state.serialize_field("start", start)?;
        }
        if !attributes.captions.is_empty() {
            state.serialize_field("captions", &CdmCaptions(&attributes.captions))?;
        }
        state.end()
    }
}

struct CdmCaptions<'a>(&'a BTreeMap<String, String>);

impl Serialize for CdmCaptions<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (language, id) in self.0 {
            map.serialize_entry(language, &AssetReference(id))?;
        }
        map.end()
    }
}

struct CdmLabelBlocks<'a>(&'a [Inline]);

impl Serialize for CdmLabelBlocks<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(usize::from(!self.0.is_empty())))?;
        if !self.0.is_empty() {
            sequence.serialize_element(&CdmSyntheticParagraph(self.0))?;
        }
        sequence.end()
    }
}

struct CdmSyntheticParagraph<'a>(&'a [Inline]);

impl Serialize for CdmSyntheticParagraph<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("Paragraph", 2)?;
        state.serialize_field("type", "paragraph")?;
        state.serialize_field("children", &CdmInlines(self.0))?;
        state.end()
    }
}

struct EmptyArray;

impl Serialize for EmptyArray {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_seq(Some(0))?.end()
    }
}

/// Parse the implemented, deliberately strict NotMarkdown 0.1 core slice.
pub fn parse(source: &str) -> ParseResult {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut diagnostics = Vec::new();
    if normalized.contains('\0') {
        diagnostics.push(error(
            "NMD_TEXT_NUL",
            "NUL is forbidden in NotMarkdown source.",
            1,
            1,
        ));
        return ParseResult {
            document: None,
            diagnostics,
        };
    }

    let lines: Vec<&str> = normalized.lines().collect();
    if lines.first().copied() != Some("@notmarkdown 0.1") {
        diagnostics.push(Diagnostic {
            code: "NMD_HEADER_REQUIRED".into(),
            severity: Severity::Error,
            message: "The first line must be @notmarkdown 0.1.".into(),
            line: 1,
            column: 1,
            suggestion: Some("Insert @notmarkdown 0.1 as the first line.".into()),
        });
        return ParseResult {
            document: None,
            diagnostics,
        };
    }

    let mut cursor = 1;
    skip_blank(&lines, &mut cursor);
    let metadata = parse_metadata(&lines, &mut cursor, &mut diagnostics);
    skip_blank(&lines, &mut cursor);
    let mut footnotes = BTreeMap::new();
    let blocks = parse_blocks(&lines, &mut cursor, &mut diagnostics, &mut footnotes);
    validate_references(&normalized, &blocks, &footnotes, &mut diagnostics);
    let valid = !diagnostics
        .iter()
        .any(|item| item.severity == Severity::Error);
    ParseResult {
        document: valid.then_some(Document {
            model_version: "0.1".into(),
            metadata,
            blocks,
            footnotes,
        }),
        diagnostics,
    }
}

fn parse_metadata(
    lines: &[&str],
    cursor: &mut usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> BTreeMap<String, Value> {
    let mut metadata = BTreeMap::new();
    if lines.get(*cursor).copied() != Some("@document {") {
        return metadata;
    }
    *cursor += 1;
    while let Some(line) = lines.get(*cursor).copied() {
        if line == "}" {
            *cursor += 1;
            return metadata;
        }
        let line_number = *cursor + 1;
        if line.trim().is_empty() {
            diagnostics.push(error(
                "NMD_METADATA_BLANK",
                "Blank lines are not allowed inside @document.",
                line_number,
                1,
            ));
            *cursor += 1;
            continue;
        }
        let Some((raw_key, raw_value)) = line.trim().split_once(':') else {
            diagnostics.push(error(
                "NMD_METADATA_FIELD",
                "Metadata fields use key: value syntax.",
                line_number,
                1,
            ));
            *cursor += 1;
            continue;
        };
        let key = raw_key.trim();
        if !valid_metadata_key(key) {
            diagnostics.push(error(
                "NMD_METADATA_KEY",
                "Invalid metadata key.",
                line_number,
                1,
            ));
        } else if metadata.contains_key(key) {
            diagnostics.push(error(
                "NMD_METADATA_DUPLICATE",
                "Duplicate metadata key.",
                line_number,
                1,
            ));
        } else {
            metadata.insert(key.into(), parse_scalar(raw_value.trim()));
        }
        *cursor += 1;
    }
    diagnostics.push(error(
        "NMD_METADATA_UNCLOSED",
        "The @document block is missing its closing brace.",
        lines.len().max(1),
        1,
    ));
    metadata
}

fn parse_blocks(
    lines: &[&str],
    cursor: &mut usize,
    diagnostics: &mut Vec<Diagnostic>,
    footnotes: &mut BTreeMap<String, Vec<Block>>,
) -> Vec<Block> {
    let mut blocks = Vec::new();
    while *cursor < lines.len() {
        skip_blank(lines, cursor);
        if *cursor >= lines.len() {
            break;
        }
        let line = lines[*cursor];
        let line_number = *cursor + 1;

        if let Some((level, text, id)) = heading(line) {
            blocks.push(Block::Heading {
                level,
                children: parse_inline(&text, line_number, diagnostics),
                id,
            });
            *cursor += 1;
        } else if line == "---" {
            blocks.push(Block::ThematicBreak);
            *cursor += 1;
        } else if line.starts_with("!toc") {
            blocks.push(parse_table_of_contents(line, line_number, diagnostics));
            *cursor += 1;
        } else if let Some(language) = line.strip_prefix("```") {
            *cursor += 1;
            let mut content = Vec::new();
            while *cursor < lines.len() && lines[*cursor] != "```" {
                content.push(lines[*cursor]);
                *cursor += 1;
            }
            if *cursor == lines.len() {
                diagnostics.push(error(
                    "NMD_CODE_UNCLOSED",
                    "The fenced code block is not closed.",
                    line_number,
                    1,
                ));
            } else {
                *cursor += 1;
            }
            blocks.push(Block::CodeBlock {
                language: (!language.is_empty()).then(|| language.to_string()),
                text: content.join("\n"),
            });
        } else if let Some(block) = parse_callout(line, line_number, diagnostics) {
            blocks.push(block);
            *cursor += 1;
        } else if let Some((mut block, has_map)) =
            parse_resource_directive(line, line_number, diagnostics)
        {
            *cursor += 1;
            if has_map {
                let attributes = parse_attribute_map(lines, cursor, diagnostics);
                apply_attributes(&mut block, attributes, diagnostics, line_number);
            }
            blocks.push(block);
        } else if let Some((id, text)) = footnote_definition(line) {
            if footnotes.contains_key(id) {
                diagnostics.push(error(
                    "NMD_FOOTNOTE_DUPLICATE",
                    "A footnote is defined more than once.",
                    line_number,
                    1,
                ));
            } else {
                footnotes.insert(
                    id.into(),
                    vec![Block::Paragraph {
                        children: parse_inline(text, line_number, diagnostics),
                    }],
                );
            }
            *cursor += 1;
        } else if line.starts_with('!') {
            diagnostics.push(error(
                "NMD_DIRECTIVE_UNSUPPORTED",
                "This directive is not implemented by the Rust 0.1 vertical slice.",
                line_number,
                1,
            ));
            *cursor += 1;
        } else if line.starts_with("> ") {
            let mut quote = Vec::new();
            while let Some(text) = lines.get(*cursor).and_then(|item| item.strip_prefix("> ")) {
                quote.push(text);
                *cursor += 1;
            }
            blocks.push(Block::Quote {
                children: vec![Block::Paragraph {
                    children: parse_inline(&quote.join("\n"), line_number, diagnostics),
                }],
            });
        } else if list_marker(line).is_some() {
            blocks.push(parse_list(lines, cursor, diagnostics, 0));
        } else {
            let mut paragraph = vec![line.trim()];
            *cursor += 1;
            while *cursor < lines.len()
                && !lines[*cursor].trim().is_empty()
                && !starts_block(lines[*cursor])
            {
                paragraph.push(lines[*cursor].trim());
                *cursor += 1;
            }
            blocks.push(Block::Paragraph {
                children: parse_inline(&paragraph.join("\n"), line_number, diagnostics),
            });
        }
    }
    blocks
}

fn parse_table_of_contents(
    line: &str,
    line_number: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Block {
    if line == "!toc" {
        return Block::TableOfContents { max_depth: None };
    }
    let depth = line
        .strip_prefix("!toc{depth=")
        .and_then(|value| value.strip_suffix('}'))
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|value| (1..=6).contains(value));
    if depth.is_none() {
        diagnostics.push(error(
            "NMD_TOC_SYNTAX",
            "Use !toc or !toc{depth=1..6}.",
            line_number,
            1,
        ));
    }
    Block::TableOfContents { max_depth: depth }
}

fn parse_list(
    lines: &[&str],
    cursor: &mut usize,
    diagnostics: &mut Vec<Diagnostic>,
    indent: usize,
) -> Block {
    let first = list_marker_at(lines[*cursor], indent).expect("caller checked marker");
    let ordered = first.0;
    let start = first.1;
    let mut items = Vec::new();
    let mut first_item = true;
    while let Some((current_ordered, marker, mut text)) = lines
        .get(*cursor)
        .and_then(|line| list_marker_at(line, indent))
    {
        if current_ordered != ordered {
            break;
        }
        if ordered && !first_item && marker != 1 {
            diagnostics.push(error(
                "NMD_LIST_MARKER",
                "After the first ordered item, use 1. for automatic numbering.",
                *cursor + 1,
                1,
            ));
        }
        let checked = if let Some(rest) = text.strip_prefix("[ ] ") {
            text = rest;
            Some(false)
        } else if let Some(rest) = text
            .strip_prefix("[x] ")
            .or_else(|| text.strip_prefix("[X] "))
        {
            text = rest;
            Some(true)
        } else {
            None
        };
        let mut item_blocks = if text.is_empty() {
            Vec::new()
        } else {
            vec![Block::Paragraph {
                children: parse_inline(text, *cursor + 1, diagnostics),
            }]
        };
        first_item = false;
        *cursor += 1;
        if lines
            .get(*cursor)
            .and_then(|line| list_marker_at(line, indent + 2))
            .is_some()
        {
            item_blocks.push(parse_list(lines, cursor, diagnostics, indent + 2));
        }
        items.push(ListItem {
            checked,
            blocks: item_blocks,
        });
    }
    Block::List {
        ordered,
        start,
        items,
    }
}

fn parse_callout(
    line: &str,
    line_number: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Block> {
    for (prefix, kind) in [
        ("!note[", CalloutKind::Note),
        ("!tip[", CalloutKind::Tip),
        ("!warning[", CalloutKind::Warning),
        ("!danger[", CalloutKind::Danger),
    ] {
        if let Some(body) = line
            .strip_prefix(prefix)
            .and_then(|item| item.strip_suffix(']'))
        {
            return Some(Block::Callout {
                kind,
                children: vec![Block::Paragraph {
                    children: parse_inline(body, line_number, diagnostics),
                }],
            });
        }
    }
    None
}

fn parse_resource_directive(
    line: &str,
    line_number: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<(Block, bool)> {
    if let Some(structured) = parse_structured_opening(line, line_number, diagnostics) {
        return Some((structured, true));
    }
    let has_map = line.ends_with(" {");
    let line = if has_map {
        line.strip_suffix(" {")?
    } else {
        line
    };
    let (kind, rest) = if let Some(rest) = line.strip_prefix("![") {
        (MediaKind::Image, rest)
    } else if let Some(rest) = line.strip_prefix("!audio[") {
        (MediaKind::Audio, rest)
    } else {
        (MediaKind::Video, line.strip_prefix("!video[")?)
    };
    let label_end = rest.find("](")?;
    let label = &rest[..label_end];
    let target_and_tail = &rest[label_end + 2..];
    let target_end = target_and_tail.find(')')?;
    let target = &target_and_tail[..target_end];
    let asset_id = target.strip_prefix("asset:")?;
    if !valid_asset_id(asset_id) {
        return None;
    }
    let tail = target_and_tail[target_end + 1..].trim();
    if !tail.is_empty() && !(tail.starts_with('{') && tail.ends_with('}')) {
        return None;
    }
    let mut block = Block::Media {
        kind,
        label: parse_inline(label, line_number, diagnostics),
        asset_id: asset_id.into(),
        attributes: MediaAttributes::default(),
        decorative: false,
    };
    if !has_map {
        let compact = if tail.is_empty() {
            BTreeMap::new()
        } else {
            compact_attributes(&tail[1..tail.len() - 1])
        };
        apply_attributes(&mut block, compact, diagnostics, line_number);
    }
    Some((block, has_map))
}

fn parse_structured_opening(
    line: &str,
    line_number: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Block> {
    let opening = line.strip_suffix(" {")?;
    for (prefix, kind) in [
        ("!diagram[", "diagram"),
        ("!chart[", "chart"),
        ("!math[", "math"),
        ("!attachment[", "attachment"),
    ] {
        let Some(rest) = opening.strip_prefix(prefix) else {
            continue;
        };
        let label_end = rest.find(']')?;
        let label = parse_inline(&rest[..label_end], line_number, diagnostics);
        let tail = &rest[label_end + 1..];
        return Some(match kind {
            "diagram" => Block::Diagram {
                diagram_type: String::new(),
                label,
                source_asset: String::new(),
            },
            "chart" => Block::Chart {
                chart_type: String::new(),
                label,
                data_asset: String::new(),
            },
            "math" => Block::MathBlock {
                notation: "tex".into(),
                source: String::new(),
            },
            _ => {
                let asset_id = tail
                    .strip_prefix("(asset:")
                    .and_then(|value| value.strip_suffix(')'))?;
                if !valid_asset_id(asset_id) {
                    return None;
                }
                Block::Attachment {
                    label,
                    asset_id: asset_id.into(),
                }
            }
        });
    }
    None
}

fn parse_attribute_map(
    lines: &[&str],
    cursor: &mut usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> BTreeMap<String, String> {
    let start = cursor.saturating_add(1);
    let mut result = BTreeMap::new();
    while *cursor < lines.len() && lines[*cursor] != "}" {
        let line = lines[*cursor];
        if let Some(entry) = line
            .strip_prefix("  ")
            .and_then(|item| item.split_once(": "))
        {
            if result.insert(entry.0.into(), unquote(entry.1)).is_some() {
                diagnostics.push(error(
                    "NMD_ATTRIBUTE_DUPLICATE",
                    "An attribute occurs more than once.",
                    *cursor + 1,
                    1,
                ));
            }
        } else {
            diagnostics.push(error(
                "NMD_MAP_ENTRY_INVALID",
                "Map entries require exactly two spaces, a key, colon, and value.",
                *cursor + 1,
                1,
            ));
        }
        *cursor += 1;
    }
    if *cursor == lines.len() {
        diagnostics.push(error(
            "NMD_MAP_UNCLOSED",
            "The directive map is not closed.",
            start,
            1,
        ));
    } else {
        *cursor += 1;
    }
    result
}

fn apply_attributes(
    block: &mut Block,
    attributes: BTreeMap<String, String>,
    diagnostics: &mut Vec<Diagnostic>,
    line: usize,
) {
    let asset = |value: Option<&String>| {
        value
            .and_then(|item| item.strip_prefix("asset:"))
            .filter(|id| valid_asset_id(id))
            .map(str::to_string)
    };
    match block {
        Block::Media {
            kind,
            label,
            attributes: target,
            decorative,
            ..
        } => {
            for (key, value) in attributes {
                match key.as_str() {
                    "layout"
                        if (*kind == MediaKind::Image
                            && matches!(
                                value.as_str(),
                                "inline" | "normal" | "wide" | "full" | "gallery"
                            ))
                            || (*kind != MediaKind::Image
                                && matches!(value.as_str(), "normal" | "wide" | "full")) =>
                    {
                        target.layout = Some(value)
                    }
                    "decorative" if *kind == MediaKind::Image && value == "true" => {
                        *decorative = true
                    }
                    "poster" | "transcript" | "chapters" if *kind != MediaKind::Image => {
                        let Some(id) = value.strip_prefix("asset:").filter(|id| valid_asset_id(id))
                        else {
                            diagnostics.push(error(
                                "NMD_ATTRIBUTE_ASSET_REQUIRED",
                                "This media attribute requires an asset reference.",
                                line,
                                1,
                            ));
                            continue;
                        };
                        match key.as_str() {
                            "poster" => target.poster = Some(id.into()),
                            "transcript" => target.transcript = Some(id.into()),
                            _ => target.chapters = Some(id.into()),
                        }
                    }
                    "start" if *kind != MediaKind::Image => target.start = Some(value),
                    _ if key.starts_with("captions.") && *kind != MediaKind::Image => {
                        let language = &key[9..];
                        let Some(id) = value.strip_prefix("asset:").filter(|id| valid_asset_id(id))
                        else {
                            diagnostics.push(error(
                                "NMD_ATTRIBUTE_ASSET_REQUIRED",
                                "Captions require an asset reference.",
                                line,
                                1,
                            ));
                            continue;
                        };
                        if language.is_empty() {
                            diagnostics.push(error(
                                "NMD_CAPTION_LANGUAGE_INVALID",
                                "A caption language is required.",
                                line,
                                1,
                            ));
                        } else {
                            target.captions.insert(language.into(), id.into());
                        }
                    }
                    _ => diagnostics.push(error(
                        "NMD_ATTRIBUTE_UNKNOWN",
                        "Unknown or invalid media attribute.",
                        line,
                        1,
                    )),
                }
            }
            if *kind == MediaKind::Image && label.is_empty() && !*decorative {
                diagnostics.push(error(
                    "NMD_IMAGE_ALT_REQUIRED",
                    "An empty image description requires decorative=true.",
                    line,
                    1,
                ));
            }
        }
        Block::Diagram {
            diagram_type,
            source_asset,
            ..
        } => {
            *diagram_type = attributes.get("type").cloned().unwrap_or_default();
            *source_asset = asset(attributes.get("source")).unwrap_or_default();
            if !matches!(diagram_type.as_str(), "flow" | "sequence" | "architecture")
                || source_asset.is_empty()
            {
                diagnostics.push(error(
                    "NMD_DIAGRAM_INVALID",
                    "A diagram requires a valid type and asset source.",
                    line,
                    1,
                ));
            }
        }
        Block::Chart {
            chart_type,
            data_asset,
            ..
        } => {
            *chart_type = attributes.get("type").cloned().unwrap_or_default();
            *data_asset = asset(attributes.get("data")).unwrap_or_default();
            if !matches!(
                chart_type.as_str(),
                "bar" | "line" | "area" | "scatter" | "pie"
            ) || data_asset.is_empty()
            {
                diagnostics.push(error(
                    "NMD_CHART_INVALID",
                    "A chart requires a valid type and asset data reference.",
                    line,
                    1,
                ));
            }
        }
        Block::MathBlock { notation, source } => {
            *notation = attributes
                .get("notation")
                .cloned()
                .unwrap_or_else(|| "tex".into());
            *source = attributes.get("source").cloned().unwrap_or_default();
            if source.is_empty() || !matches!(notation.as_str(), "tex" | "asciimath") {
                diagnostics.push(error(
                    "NMD_MATH_INVALID",
                    "A math block requires source and a supported notation.",
                    line,
                    1,
                ));
            }
        }
        Block::Attachment { .. } => {}
        _ => {}
    }
}

fn heading(line: &str) -> Option<(u8, String, Option<String>)> {
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&hashes) || line.as_bytes().get(hashes) != Some(&b' ') {
        return None;
    }
    let mut text = line[hashes + 1..].trim().to_string();
    let mut id = None;
    if text.ends_with('}')
        && let Some(start) = text.rfind(" {#")
    {
        let candidate = &text[start + 3..text.len() - 1];
        if valid_id(candidate) {
            id = Some(candidate.into());
            text.truncate(start);
        }
    }
    Some((hashes as u8, text, id))
}

fn list_marker(line: &str) -> Option<(bool, usize, &str)> {
    list_marker_at(line, 0)
}

fn list_marker_at(line: &str, indent: usize) -> Option<(bool, usize, &str)> {
    let line = line.strip_prefix(&" ".repeat(indent))?;
    if line.starts_with(' ') {
        return None;
    }
    if let Some(text) = line.strip_prefix("- ") {
        return Some((false, 1, text));
    }
    let (marker, text) = line.split_once(". ")?;
    if marker.is_empty() || !marker.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = marker.parse::<usize>().ok()?;
    (value > 0).then_some((true, value, text))
}

fn footnote_definition(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("[^")?;
    let (id, text) = rest.split_once("]: ")?;
    valid_id(id).then_some((id, text))
}

fn validate_references(
    source: &str,
    blocks: &[Block],
    footnotes: &BTreeMap<String, Vec<Block>>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let ids: BTreeSet<&str> = blocks
        .iter()
        .filter_map(|block| match block {
            Block::Heading { id: Some(id), .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    for (line_index, line) in source.lines().enumerate() {
        let mut tail = line;
        while let Some(start) = tail.find("](#") {
            let after = &tail[start + 3..];
            if let Some(end) = after.find(')') {
                let id = &after[..end];
                if valid_id(id) && !ids.contains(id) {
                    diagnostics.push(error(
                        "NMD_REFERENCE_UNRESOLVED",
                        "An internal reference has no target.",
                        line_index + 1,
                        start + 1,
                    ));
                }
                tail = &after[end + 1..];
            } else {
                break;
            }
        }
        let mut tail = line;
        while let Some(start) = tail.find("[^") {
            let after = &tail[start + 2..];
            if let Some(end) = after.find(']') {
                let id = &after[..end];
                if !line.starts_with("[^") && valid_id(id) && !footnotes.contains_key(id) {
                    diagnostics.push(error(
                        "NMD_FOOTNOTE_UNRESOLVED",
                        "A footnote reference has no definition.",
                        line_index + 1,
                        start + 1,
                    ));
                }
                tail = &after[end + 1..];
            } else {
                break;
            }
        }
    }
}

fn unquote(value: &str) -> String {
    if value.starts_with('"') {
        serde_json::from_str(value).unwrap_or_else(|_| value.into())
    } else {
        value.into()
    }
}

fn compact_attributes(source: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for item in source.split_whitespace() {
        if let Some((key, value)) = item.split_once('=') {
            result.insert(key.into(), unquote(value));
        }
    }
    result
}

fn starts_block(line: &str) -> bool {
    line == "---"
        || line.starts_with('#')
        || line.starts_with("```")
        || line.starts_with('!')
        || line.starts_with("> ")
        || footnote_definition(line).is_some()
        || list_marker(line).is_some()
}

fn skip_blank(lines: &[&str], cursor: &mut usize) {
    while lines
        .get(*cursor)
        .is_some_and(|line| line.trim().is_empty())
    {
        *cursor += 1;
    }
}

fn parse_scalar(raw: &str) -> Value {
    if raw.starts_with('"') {
        serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.into()))
    } else if raw == "true" {
        Value::Bool(true)
    } else if raw == "false" {
        Value::Bool(false)
    } else if let Ok(number) = raw.parse::<i64>() {
        Value::Number(number.into())
    } else {
        Value::String(raw.into())
    }
}

fn valid_metadata_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_id(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_asset_id(value: &str) -> bool {
    valid_id(value)
}

fn parse_inline(source: &str, line: usize, diagnostics: &mut Vec<Diagnostic>) -> Vec<Inline> {
    let mut result = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        let tail = &source[cursor..];
        if tail.starts_with("***") || tail.starts_with("___") {
            diagnostics.push(error(
                "NMD_INLINE_DELIMITER_AMBIGUOUS",
                "Runs of three or more emphasis delimiters are forbidden.",
                line,
                cursor + 1,
            ));
            push_text(&mut result, &tail[..3]);
            cursor += 3;
        } else if tail.starts_with("\\\n") {
            result.push(Inline::HardBreak);
            cursor += 2;
        } else if tail.starts_with('\n') {
            push_text(&mut result, " ");
            cursor += 1;
        } else if let Some(stripped) = tail.strip_prefix('`') {
            if let Some(end) = stripped.find('`') {
                result.push(Inline::Code {
                    text: stripped[..end].into(),
                });
                cursor += end + 2;
            } else {
                diagnostics.push(error(
                    "NMD_CODE_SPAN_UNCLOSED",
                    "The inline code span is not closed.",
                    line,
                    cursor + 1,
                ));
                push_text(&mut result, "`");
                cursor += 1;
            }
        } else if tail.starts_with("![") {
            if let Some((label, target, attributes, consumed)) = inline_link_parts(tail, true) {
                if let Some(asset_id) = target
                    .strip_prefix("asset:")
                    .filter(|id| valid_asset_id(id))
                {
                    let raw = compact_attributes(attributes.unwrap_or_default());
                    let layout = raw.get("layout").cloned();
                    let decorative = raw.get("decorative").is_some_and(|item| item == "true");
                    if label.is_empty() && !decorative {
                        diagnostics.push(error(
                            "NMD_IMAGE_ALT_REQUIRED",
                            "An empty image description requires decorative=true.",
                            line,
                            cursor + 1,
                        ));
                    }
                    result.push(Inline::Image {
                        asset_id: asset_id.into(),
                        alt: label.into(),
                        attributes: FigureAttributes { layout },
                        decorative,
                    });
                } else {
                    diagnostics.push(error(
                        "NMD_ASSET_ID_INVALID",
                        "Inline images require a valid asset reference.",
                        line,
                        cursor + 1,
                    ));
                }
                cursor += consumed;
            } else {
                push_text(&mut result, "!");
                cursor += 1;
            }
        } else if tail.starts_with("[^") {
            if let Some(end) = tail.find(']') {
                let id = &tail[2..end];
                if valid_id(id) {
                    result.push(Inline::FootnoteReference { target: id.into() });
                    cursor += end + 1;
                } else {
                    push_text(&mut result, "[");
                    cursor += 1;
                }
            } else {
                push_text(&mut result, "[");
                cursor += 1;
            }
        } else if tail.starts_with('[') {
            if let Some((label, target, _, consumed)) = inline_link_parts(tail, false) {
                if let Some(id) = target.strip_prefix('#').filter(|id| valid_id(id)) {
                    result.push(Inline::CrossReference {
                        target: id.into(),
                        children: parse_inline(label, line, diagnostics),
                    });
                } else if let Some(reference) = parse_reference(target) {
                    result.push(Inline::Link {
                        target: reference,
                        children: parse_inline(label, line, diagnostics),
                    });
                } else {
                    diagnostics.push(error(
                        "NMD_REFERENCE_UNRESOLVED_LOCAL",
                        "Local references must be converted to asset IDs.",
                        line,
                        cursor + 1,
                    ));
                }
                cursor += consumed;
            } else {
                push_text(&mut result, "[");
                cursor += 1;
            }
        } else if tail.starts_with("**") || tail.starts_with("__") {
            let marker = &tail[..2];
            if let Some(end) = tail[2..].find(marker) {
                result.push(Inline::Strong {
                    children: parse_inline(&tail[2..end + 2], line, diagnostics),
                });
                cursor += end + 4;
            } else {
                push_text(&mut result, marker);
                cursor += 2;
            }
        } else if tail.starts_with('*') || tail.starts_with('_') {
            let marker = &tail[..1];
            if let Some(end) = tail[1..].find(marker) {
                result.push(Inline::Emphasis {
                    children: parse_inline(&tail[1..end + 1], line, diagnostics),
                });
                cursor += end + 2;
            } else {
                push_text(&mut result, marker);
                cursor += 1;
            }
        } else if let Some(stripped) = tail.strip_prefix('$') {
            if let Some(end) = stripped.find('$') {
                result.push(Inline::MathInline {
                    source: stripped[..end].into(),
                    notation: "tex".into(),
                });
                cursor += end + 2;
            } else {
                push_text(&mut result, "$");
                cursor += 1;
            }
        } else if let Some(stripped) = tail.strip_prefix('\\') {
            let escaped = stripped.chars().next();
            if escaped.is_some_and(|item| "\\*_`[]()#!{}$>-.".contains(item)) {
                let escaped = escaped.expect("checked");
                push_text(&mut result, &escaped.to_string());
                cursor += 1 + escaped.len_utf8();
            } else {
                diagnostics.push(error(
                    "NMD_ESCAPE_INVALID",
                    "This character cannot be escaped.",
                    line,
                    cursor + 1,
                ));
                push_text(&mut result, "\\");
                cursor += 1;
            }
        } else {
            let character = tail.chars().next().expect("valid UTF-8");
            push_text(&mut result, &character.to_string());
            cursor += character.len_utf8();
        }
    }
    result
}

fn inline_link_parts(source: &str, image: bool) -> Option<(&str, &str, Option<&str>, usize)> {
    let label_start = if image { 2 } else { 1 };
    let label_end = source[label_start..].find("](")? + label_start;
    let target_start = label_end + 2;
    let target_end = source[target_start..].find(')')? + target_start;
    let mut consumed = target_end + 1;
    let mut attributes = None;
    if source[consumed..].starts_with('{') {
        let end = source[consumed + 1..].find('}')? + consumed + 1;
        attributes = Some(&source[consumed + 1..end]);
        consumed = end + 1;
    }
    Some((
        &source[label_start..label_end],
        &source[target_start..target_end],
        attributes,
        consumed,
    ))
}

fn parse_reference(source: &str) -> Option<Reference> {
    if let Some(id) = source
        .strip_prefix("asset:")
        .filter(|id| valid_asset_id(id))
    {
        Some(Reference::Asset { id: id.into() })
    } else if let Some(id) = source.strip_prefix('#').filter(|id| valid_id(id)) {
        Some(Reference::Internal { id: id.into() })
    } else if source.starts_with("https://") && source.len() > 8 {
        Some(Reference::External {
            uri: normalize_https_uri(source)?,
        })
    } else {
        None
    }
}

fn normalize_https_uri(source: &str) -> Option<String> {
    let remainder = source.strip_prefix("https://")?;
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    if authority_end == 0 {
        return None;
    }
    if remainder.as_bytes().get(authority_end) == Some(&b'/') {
        Some(source.into())
    } else {
        Some(format!(
            "https://{}/{}",
            &remainder[..authority_end],
            &remainder[authority_end..]
        ))
    }
}

fn push_text(result: &mut Vec<Inline>, value: &str) {
    if let Some(Inline::Text { text }) = result.last_mut() {
        text.push_str(value);
    } else {
        result.push(Inline::Text { text: value.into() });
    }
}

fn inline_plain(nodes: &[Inline]) -> String {
    let mut result = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } | Inline::Code { text } => result.push_str(text),
            Inline::Emphasis { children }
            | Inline::Strong { children }
            | Inline::Link { children, .. }
            | Inline::CrossReference { children, .. } => result.push_str(&inline_plain(children)),
            Inline::Image { alt, .. } => result.push_str(alt),
            Inline::HardBreak => result.push('\n'),
            Inline::FootnoteReference { target } => {
                result.push_str(&format!("[^{target}]"));
            }
            Inline::MathInline { source, .. } => result.push_str(&format!("${source}$")),
        }
    }
    result
}

fn error(code: &str, message: &str, line: usize, column: usize) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        severity: Severity::Error,
        message: message.into(),
        line,
        column,
        suggestion: None,
    }
}

/// Derive the document outline from headings in reading order. Generated paths
/// are CDM JSON Pointers and do not require visible source IDs.
pub fn outline(document: &Document) -> Vec<OutlineEntry> {
    fn visit(blocks: &[Block], base: &str, entries: &mut Vec<OutlineEntry>) {
        for (index, block) in blocks.iter().enumerate() {
            let path = format!("{base}/{index}");
            match block {
                Block::Heading {
                    level,
                    children,
                    id,
                } => entries.push(OutlineEntry {
                    level: *level,
                    title: normalize_search_text(&inline_search_text(children)),
                    id: id.clone(),
                    path,
                }),
                Block::Quote { children } | Block::Callout { children, .. } => {
                    visit(children, &format!("{path}/children"), entries);
                }
                Block::List { items, .. } => {
                    for (item_index, item) in items.iter().enumerate() {
                        visit(
                            &item.blocks,
                            &format!("{path}/children/{item_index}/children"),
                            entries,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    let mut entries = Vec::new();
    visit(&document.blocks, "/children", &mut entries);
    entries
}

/// Build a deterministic, disposable full-text index from canonical document
/// content. The authoritative document never depends on this derived data.
pub fn build_search_index(document: &Document) -> SearchIndex {
    fn visit(
        blocks: &[Block],
        base: &str,
        section: &mut Option<String>,
        entries: &mut Vec<SearchEntry>,
    ) {
        for (index, block) in blocks.iter().enumerate() {
            let path = format!("{base}/{index}");
            if let Block::Heading { children, .. } = block {
                *section = Some(normalize_search_text(&inline_search_text(children)));
            }
            if let Some((kind, text)) = searchable_block(block) {
                let text = normalize_search_text(&text);
                if !text.is_empty() {
                    entries.push(SearchEntry {
                        path: path.clone(),
                        kind: kind.into(),
                        section: section.clone(),
                        origin: None,
                        asset_id: None,
                        role: None,
                        media_type: None,
                        package_path: None,
                        text,
                    });
                }
            }
            match block {
                Block::Quote { children } | Block::Callout { children, .. } => {
                    visit(children, &format!("{path}/children"), section, entries);
                }
                Block::List { items, .. } => {
                    for (item_index, item) in items.iter().enumerate() {
                        visit(
                            &item.blocks,
                            &format!("{path}/children/{item_index}/children"),
                            section,
                            entries,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    let mut entries = Vec::new();
    let mut section = None;
    visit(&document.blocks, "/children", &mut section, &mut entries);
    for (id, blocks) in &document.footnotes {
        let mut footnote_section = Some(format!("Footnote {id}"));
        visit(
            blocks,
            &format!("/definitions/footnotes/{}", escape_json_pointer(id)),
            &mut footnote_section,
            &mut entries,
        );
    }
    SearchIndex {
        index_version: "0.2".into(),
        document_model_version: document.model_version.clone(),
        entries,
        omissions: Vec::new(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetSearchSite {
    path: String,
    role: String,
    section: Option<String>,
}

/// Add verified textual package representations to the disposable document
/// index. Binary media and unsupported textual formats are ignored. Asset
/// entries remain anchored to their first semantic document reference.
pub fn build_search_index_with_assets(document: &Document, assets: &[SearchAsset]) -> SearchIndex {
    let cached_assets = assets
        .iter()
        .enumerate()
        .map(|(index, asset)| CachedSearchAsset {
            id: asset.id.clone(),
            package_path: asset.package_path.clone(),
            media_type: asset.media_type.clone(),
            fingerprint: format!("one-shot-{index}"),
            bytes: asset.data.len(),
            data: Some(asset.data.clone()),
        })
        .collect::<Vec<_>>();
    IncrementalSearchCache::default()
        .update(document, "one-shot", &cached_assets)
        .expect("one-shot search assets always contain bytes")
        .index
}

impl IncrementalSearchCache {
    pub fn contains_asset(
        &self,
        id: &str,
        package_path: &str,
        media_type: &str,
        fingerprint: &str,
    ) -> bool {
        self.assets
            .get(&search_asset_cache_key(id, package_path))
            .is_some_and(|entry| entry.fingerprint == fingerprint && entry.media_type == media_type)
    }

    pub fn update(
        &mut self,
        document: &Document,
        document_fingerprint: &str,
        assets: &[CachedSearchAsset],
    ) -> Result<SearchCacheUpdate, SearchCacheMiss> {
        let document_reused = self.document_fingerprint.as_deref() == Some(document_fingerprint)
            && self.document_index.is_some();
        let mut index = if document_reused {
            self.document_index
                .clone()
                .expect("checked cached document index")
        } else {
            let next = build_search_index(document);
            self.document_fingerprint = Some(document_fingerprint.into());
            self.document_index = Some(next.clone());
            next
        };
        let sites = asset_search_sites(document);
        let mut ordered: Vec<_> = assets.iter().collect();
        ordered.sort_by(|left, right| {
            left.id
                .cmp(&right.id)
                .then_with(|| left.package_path.cmp(&right.package_path))
        });

        let mut eligible = Vec::new();
        let mut total_bytes = 0_usize;
        for asset in ordered {
            if !is_searchable_media_type(&asset.media_type) || !sites.contains_key(&asset.id) {
                continue;
            }
            if asset.bytes > MAX_SEARCH_ASSET_BYTES
                || total_bytes.saturating_add(asset.bytes) > MAX_TOTAL_SEARCH_ASSET_BYTES
            {
                index.omissions.push(SearchOmission {
                    asset_id: asset.id.clone(),
                    package_path: asset.package_path.clone(),
                    reason: "sizeLimit".into(),
                });
                continue;
            }
            total_bytes += asset.bytes;
            if !self.contains_asset(
                &asset.id,
                &asset.package_path,
                &asset.media_type,
                &asset.fingerprint,
            ) && asset.data.is_none()
            {
                return Err(SearchCacheMiss {
                    asset_id: asset.id.clone(),
                    package_path: asset.package_path.clone(),
                });
            }
            eligible.push(asset);
        }

        let mut assets_reused = 0_usize;
        let mut assets_reindexed = 0_usize;
        let active_keys: BTreeSet<_> = eligible
            .iter()
            .map(|asset| search_asset_cache_key(&asset.id, &asset.package_path))
            .collect();
        let previous_assets = self.assets.len();
        self.assets.retain(|key, _| active_keys.contains(key));
        let assets_removed = previous_assets.saturating_sub(self.assets.len());

        for asset in eligible {
            let key = search_asset_cache_key(&asset.id, &asset.package_path);
            let reused = self.contains_asset(
                &asset.id,
                &asset.package_path,
                &asset.media_type,
                &asset.fingerprint,
            );
            if reused {
                assets_reused += 1;
            } else {
                let data = asset
                    .data
                    .as_deref()
                    .expect("cache miss preflight checked bytes");
                let value = match std::str::from_utf8(data) {
                    Ok(text) => CachedAssetText::Text(extract_searchable_asset_text(
                        text,
                        &asset.media_type,
                    )),
                    Err(_) => CachedAssetText::Omission("invalidUtf8".into()),
                };
                self.assets.insert(
                    key.clone(),
                    CachedAssetEntry {
                        fingerprint: asset.fingerprint.clone(),
                        media_type: asset.media_type.clone(),
                        value,
                    },
                );
                assets_reindexed += 1;
            }

            let cached = self.assets.get(&key).expect("cached asset after update");
            match &cached.value {
                CachedAssetText::Text(text) if !text.is_empty() => {
                    let site = &sites[&asset.id];
                    index.entries.push(SearchEntry {
                        path: site.path.clone(),
                        kind: asset_search_kind(&site.role).into(),
                        section: site.section.clone(),
                        origin: Some("asset".into()),
                        asset_id: Some(asset.id.clone()),
                        role: Some(site.role.clone()),
                        media_type: Some(asset.media_type.clone()),
                        package_path: Some(asset.package_path.clone()),
                        text: text.clone(),
                    });
                }
                CachedAssetText::Omission(reason) => index.omissions.push(SearchOmission {
                    asset_id: asset.id.clone(),
                    package_path: asset.package_path.clone(),
                    reason: reason.clone(),
                }),
                CachedAssetText::Text(_) => {}
            }
        }

        index.omissions.sort_by(|left, right| {
            left.asset_id
                .cmp(&right.asset_id)
                .then_with(|| left.package_path.cmp(&right.package_path))
        });

        self.generation = self.generation.saturating_add(1);
        let stats = SearchCacheStats {
            generation: self.generation,
            document_reused,
            assets_reused,
            assets_reindexed,
            assets_removed,
            entries: index.entries.len(),
            omissions: index.omissions.len(),
        };
        Ok(SearchCacheUpdate { index, stats })
    }
}

fn search_asset_cache_key(id: &str, package_path: &str) -> String {
    format!("{id}\0{package_path}")
}

pub fn is_searchable_media_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "text/plain"
            | "text/markdown"
            | "text/vnd.mermaid"
            | "text/vtt"
            | "text/csv"
            | "text/tab-separated-values"
            | "application/json"
            | "application/vnd.vegalite+json"
            | "application/vnd.vegalite.v5+json"
            | "application/vnd.vegalite.v6+json"
            | "application/yaml"
            | "application/xml"
            | "application/x-subrip"
    )
}

fn asset_search_kind(role: &str) -> &'static str {
    match role {
        "captions" => "captions",
        "transcript" => "transcript",
        "chapters" => "chapters",
        "attachment" => "attachmentText",
        "source" => "sourceText",
        "data" => "dataText",
        _ => "assetText",
    }
}

fn extract_searchable_asset_text(source: &str, media_type: &str) -> String {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    if media_type != "text/vtt" {
        return normalize_search_text(source);
    }
    let mut output = Vec::new();
    let mut skip_block = false;
    for (index, raw_line) in source.lines().enumerate() {
        let line = raw_line.trim();
        if index == 0 && line.starts_with("WEBVTT") {
            continue;
        }
        if line.is_empty() {
            skip_block = false;
            continue;
        }
        if skip_block {
            continue;
        }
        if line == "STYLE" || line == "REGION" || line == "NOTE" || line.starts_with("NOTE ") {
            skip_block = true;
            continue;
        }
        if line.contains("-->") || line.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let mut visible = String::new();
        let mut in_tag = false;
        for character in line.chars() {
            match character {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                _ if !in_tag => visible.push(character),
                _ => {}
            }
        }
        let visible = visible
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&nbsp;", " ");
        if !visible.trim().is_empty() {
            output.push(visible);
        }
    }
    normalize_search_text(&output.join(" "))
}

fn asset_search_sites(document: &Document) -> BTreeMap<String, AssetSearchSite> {
    fn record(
        sites: &mut BTreeMap<String, AssetSearchSite>,
        id: &str,
        path: &str,
        role: &str,
        section: &Option<String>,
    ) {
        sites.entry(id.into()).or_insert_with(|| AssetSearchSite {
            path: path.into(),
            role: role.into(),
            section: section.clone(),
        });
    }
    fn visit_inline(
        nodes: &[Inline],
        path: &str,
        section: &Option<String>,
        sites: &mut BTreeMap<String, AssetSearchSite>,
    ) {
        for node in nodes {
            match node {
                Inline::Image { asset_id, .. } => {
                    record(sites, asset_id, path, "image", section);
                }
                Inline::Link {
                    target: Reference::Asset { id },
                    children,
                } => {
                    record(sites, id, path, "attachment", section);
                    visit_inline(children, path, section, sites);
                }
                Inline::Emphasis { children }
                | Inline::Strong { children }
                | Inline::Link { children, .. }
                | Inline::CrossReference { children, .. } => {
                    visit_inline(children, path, section, sites);
                }
                _ => {}
            }
        }
    }
    fn visit(
        blocks: &[Block],
        base: &str,
        section: &mut Option<String>,
        sites: &mut BTreeMap<String, AssetSearchSite>,
    ) {
        for (index, block) in blocks.iter().enumerate() {
            let path = format!("{base}/{index}");
            if let Block::Heading { children, .. } = block {
                *section = Some(normalize_search_text(&inline_search_text(children)));
            }
            match block {
                Block::Heading { children, .. } | Block::Paragraph { children } => {
                    visit_inline(children, &path, section, sites);
                }
                Block::Media {
                    kind,
                    label,
                    asset_id,
                    attributes,
                    ..
                } => {
                    let primary_role = if *kind == MediaKind::Image {
                        "image"
                    } else {
                        "playback"
                    };
                    record(sites, asset_id, &path, primary_role, section);
                    if let Some(id) = &attributes.poster {
                        record(sites, id, &path, "poster", section);
                    }
                    if let Some(id) = &attributes.transcript {
                        record(sites, id, &path, "transcript", section);
                    }
                    if let Some(id) = &attributes.chapters {
                        record(sites, id, &path, "chapters", section);
                    }
                    for id in attributes.captions.values() {
                        record(sites, id, &path, "captions", section);
                    }
                    visit_inline(label, &path, section, sites);
                }
                Block::Diagram {
                    label,
                    source_asset,
                    ..
                } => {
                    record(sites, source_asset, &path, "source", section);
                    visit_inline(label, &path, section, sites);
                }
                Block::Chart {
                    label, data_asset, ..
                } => {
                    record(sites, data_asset, &path, "data", section);
                    visit_inline(label, &path, section, sites);
                }
                Block::Attachment { label, asset_id } => {
                    record(sites, asset_id, &path, "attachment", section);
                    visit_inline(label, &path, section, sites);
                }
                Block::Quote { children } | Block::Callout { children, .. } => {
                    visit(children, &format!("{path}/children"), section, sites);
                }
                Block::List { items, .. } => {
                    for (item_index, item) in items.iter().enumerate() {
                        visit(
                            &item.blocks,
                            &format!("{path}/children/{item_index}/children"),
                            section,
                            sites,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    let mut sites = BTreeMap::new();
    let mut section = None;
    visit(&document.blocks, "/children", &mut section, &mut sites);
    for (id, blocks) in &document.footnotes {
        let mut footnote_section = Some(format!("Footnote {id}"));
        visit(
            blocks,
            &format!("/definitions/footnotes/{}", escape_json_pointer(id)),
            &mut footnote_section,
            &mut sites,
        );
    }
    sites
}

/// Search a previously derived index. Results are deterministic: relevance,
/// then CDM path.
pub fn search_index(index: &SearchIndex, query: &str, limit: usize) -> Vec<SearchHit> {
    let phrase = query.trim().to_lowercase();
    let terms: Vec<&str> = phrase.split_whitespace().collect();
    if terms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for entry in &index.entries {
        let haystack = entry.text.to_lowercase();
        if !terms.iter().all(|term| haystack.contains(term)) {
            continue;
        }
        let mut score = match entry.kind.as_str() {
            "heading" => 100,
            "figure" | "audio" | "video" | "attachment" => 80,
            "captions" | "transcript" | "chapters" | "attachmentText" | "sourceText"
            | "dataText" | "assetText" => 70,
            _ => 60,
        };
        if haystack == phrase {
            score += 50;
        } else if haystack.starts_with(&phrase) {
            score += 25;
        }
        if entry
            .section
            .as_ref()
            .is_some_and(|section| section.to_lowercase().contains(&phrase))
        {
            score += 10;
        }
        hits.push(SearchHit {
            path: entry.path.clone(),
            kind: entry.kind.clone(),
            section: entry.section.clone(),
            origin: entry.origin.clone(),
            asset_id: entry.asset_id.clone(),
            role: entry.role.clone(),
            media_type: entry.media_type.clone(),
            package_path: entry.package_path.clone(),
            context: search_context(&entry.text, &phrase),
            score,
        });
    }
    hits.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.asset_id.cmp(&right.asset_id))
            .then_with(|| left.package_path.cmp(&right.package_path))
    });
    hits.truncate(limit);
    hits
}

pub fn search_document(document: &Document, query: &str, limit: usize) -> Vec<SearchHit> {
    search_index(&build_search_index(document), query, limit)
}

fn searchable_block(block: &Block) -> Option<(&'static str, String)> {
    match block {
        Block::Heading { children, .. } => Some(("heading", inline_search_text(children))),
        Block::Paragraph { children } => Some(("paragraph", inline_search_text(children))),
        Block::CodeBlock { text, .. } => Some(("codeBlock", text.clone())),
        Block::Media {
            kind,
            label,
            asset_id,
            attributes,
            ..
        } => {
            let kind = match kind {
                MediaKind::Image => "figure",
                MediaKind::Audio => "audio",
                MediaKind::Video => "video",
            };
            let mut text = format!("{} {asset_id}", inline_search_text(label));
            for id in attributes
                .poster
                .iter()
                .chain(attributes.transcript.iter())
                .chain(attributes.chapters.iter())
                .chain(attributes.captions.values())
            {
                text.push(' ');
                text.push_str(id);
            }
            Some((kind, text))
        }
        Block::Diagram {
            label,
            source_asset,
            ..
        } => Some((
            "diagram",
            format!("{} {source_asset}", inline_search_text(label)),
        )),
        Block::Chart {
            label, data_asset, ..
        } => Some((
            "chart",
            format!("{} {data_asset}", inline_search_text(label)),
        )),
        Block::MathBlock { source, .. } => Some(("mathBlock", source.clone())),
        Block::Attachment { label, asset_id } => Some((
            "attachment",
            format!("{} {asset_id}", inline_search_text(label)),
        )),
        _ => None,
    }
}

fn inline_search_text(nodes: &[Inline]) -> String {
    let mut result = String::new();
    for node in nodes {
        match node {
            Inline::Text { text } | Inline::Code { text } => result.push_str(text),
            Inline::Emphasis { children }
            | Inline::Strong { children }
            | Inline::Link { children, .. }
            | Inline::CrossReference { children, .. } => {
                result.push_str(&inline_search_text(children));
            }
            Inline::Image { alt, .. } => result.push_str(alt),
            Inline::HardBreak => result.push(' '),
            Inline::FootnoteReference { target } => {
                result.push(' ');
                result.push_str(target);
                result.push(' ');
            }
            Inline::MathInline { source, .. } => result.push_str(source),
        }
    }
    result
}

fn normalize_search_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn search_context(text: &str, phrase: &str) -> String {
    const WIDTH: usize = 160;
    const BEFORE: usize = 48;
    let characters: Vec<char> = text.chars().collect();
    if characters.len() <= WIDTH {
        return text.into();
    }
    let lowered = text.to_lowercase();
    let match_character = lowered
        .find(phrase)
        .map(|byte| lowered[..byte].chars().count())
        .unwrap_or(0);
    let start = match_character.saturating_sub(BEFORE);
    let end = (start + WIDTH).min(characters.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        characters[start..end].iter().collect::<String>(),
        if end < characters.len() { "…" } else { "" }
    )
}

fn escape_json_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

pub fn collect_asset_ids(document: &Document) -> BTreeSet<String> {
    fn visit_inline(nodes: &[Inline], result: &mut BTreeSet<String>) {
        for node in nodes {
            match node {
                Inline::Image { asset_id, .. } => {
                    result.insert(asset_id.clone());
                }
                Inline::Link {
                    target: Reference::Asset { id },
                    children,
                } => {
                    result.insert(id.clone());
                    visit_inline(children, result);
                }
                Inline::Emphasis { children }
                | Inline::Strong { children }
                | Inline::Link { children, .. }
                | Inline::CrossReference { children, .. } => visit_inline(children, result),
                _ => {}
            }
        }
    }
    fn visit(blocks: &[Block], result: &mut BTreeSet<String>) {
        for block in blocks {
            match block {
                Block::Media {
                    asset_id,
                    attributes,
                    ..
                } => {
                    result.insert(asset_id.clone());
                    for id in [
                        attributes.poster.as_ref(),
                        attributes.transcript.as_ref(),
                        attributes.chapters.as_ref(),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        result.insert(id.clone());
                    }
                    result.extend(attributes.captions.values().cloned());
                }
                Block::Diagram {
                    source_asset,
                    label,
                    ..
                } => {
                    result.insert(source_asset.clone());
                    visit_inline(label, result);
                }
                Block::Chart {
                    data_asset, label, ..
                } => {
                    result.insert(data_asset.clone());
                    visit_inline(label, result);
                }
                Block::Attachment { asset_id, label } => {
                    result.insert(asset_id.clone());
                    visit_inline(label, result);
                }
                Block::List { items, .. } => {
                    for item in items {
                        visit(&item.blocks, result);
                    }
                }
                Block::Heading { children, .. } | Block::Paragraph { children } => {
                    visit_inline(children, result)
                }
                Block::Quote { children } | Block::Callout { children, .. } => {
                    visit(children, result)
                }
                _ => {}
            }
        }
    }
    let mut result = BTreeSet::new();
    visit(&document.blocks, &mut result);
    for blocks in document.footnotes.values() {
        visit(blocks, &mut result);
    }
    result
}

/// Produce a semantic, media-safe terminal representation.
pub fn render_terminal(document: &Document) -> Vec<String> {
    let mut output = Vec::new();
    let document_outline = outline(document);
    if let Some(Value::String(title)) = document.metadata.get("title") {
        output.push(title.clone());
        output.push("═".repeat(title.chars().count().max(3)));
        output.push(String::new());
    }
    for block in &document.blocks {
        match block {
            Block::Heading {
                level, children, ..
            } => {
                output.push(format!(
                    "{} {}",
                    "#".repeat(*level as usize),
                    inline_plain(children)
                ));
                output.push(String::new());
            }
            Block::Paragraph { children } => {
                output.push(inline_plain(children));
                output.push(String::new());
            }
            Block::ThematicBreak => output.push("─".repeat(48)),
            Block::TableOfContents { max_depth } => {
                output.push("Contents".into());
                output.push("────────".into());
                for entry in document_outline
                    .iter()
                    .filter(|entry| max_depth.is_none_or(|depth| entry.level <= depth))
                {
                    output.push(format!(
                        "{}• {}",
                        "  ".repeat(entry.level.saturating_sub(1) as usize),
                        entry.title
                    ));
                }
                output.push(String::new());
            }
            Block::Quote { children } => {
                output.extend(render_blocks(children).into_iter().map(|line| {
                    if line.is_empty() {
                        "│".into()
                    } else {
                        format!("│ {line}")
                    }
                }));
                output.push(String::new());
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                for (offset, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}.", start + offset)
                    } else {
                        "•".into()
                    };
                    let task = match item.checked {
                        Some(true) => "[x] ",
                        Some(false) => "[ ] ",
                        None => "",
                    };
                    let first = item
                        .blocks
                        .first()
                        .and_then(|block| match block {
                            Block::Paragraph { children } => Some(inline_plain(children)),
                            _ => None,
                        })
                        .unwrap_or_default();
                    output.push(format!("  {marker:<4} {task}{first}"));
                    for nested in item.blocks.iter().skip(1) {
                        for line in render_blocks(std::slice::from_ref(nested)) {
                            output.push(format!("       {line}"));
                        }
                    }
                }
                output.push(String::new());
            }
            Block::CodeBlock { language, text } => {
                let description = match language.as_deref().and_then(renderable_notation) {
                    Some(RenderableNotation::Mermaid) => "mermaid source",
                    Some(RenderableNotation::VegaLite) => "Vega-Lite source",
                    None => "code",
                };
                output.push(format!(
                    "┌─ {description} {}",
                    language.as_deref().unwrap_or("")
                ));
                output.extend(text.lines().map(|line| format!("│ {line}")));
                output.push("└─".into());
                output.push(String::new());
            }
            Block::Callout { kind, children } => {
                let text = render_blocks(children).join(" ");
                output.push(format!("▌{:?}: {text}", kind).to_uppercase());
                output.push(String::new());
            }
            Block::Media {
                kind,
                label,
                asset_id,
                ..
            } => {
                output.push(format!(
                    "[{:?} · asset:{}] {}",
                    kind,
                    asset_id,
                    inline_plain(label)
                ));
                if matches!(kind, MediaKind::Audio | MediaKind::Video) {
                    output.push(
                        "  Playback depends on the terminal; inspect package fallbacks.".into(),
                    );
                }
                output.push(String::new());
            }
            Block::Diagram {
                diagram_type,
                label,
                source_asset,
            } => output.push(format!(
                "[Diagram · {diagram_type} · asset:{source_asset}] {}",
                inline_plain(label)
            )),
            Block::Chart {
                chart_type,
                label,
                data_asset,
            } => output.push(format!(
                "[Chart · {chart_type} · asset:{data_asset}] {}",
                inline_plain(label)
            )),
            Block::MathBlock { notation, source } => {
                output.push(format!("[Math · {notation}] {source}"))
            }
            Block::Attachment { label, asset_id } => output.push(format!(
                "[Attachment · asset:{asset_id}] {}",
                inline_plain(label)
            )),
        }
    }
    output
}

/// Return the first rendered terminal line for every top-level CDM block.
/// Editors use this derived map for outline and search navigation.
pub fn terminal_block_offsets(document: &Document) -> Vec<usize> {
    let document_outline = outline(document);
    let mut offset = if matches!(document.metadata.get("title"), Some(Value::String(_))) {
        3
    } else {
        0
    };
    let mut offsets = Vec::with_capacity(document.blocks.len());
    for block in &document.blocks {
        offsets.push(offset);
        let block_lines = if let Block::TableOfContents { max_depth } = block {
            3 + document_outline
                .iter()
                .filter(|entry| max_depth.is_none_or(|depth| entry.level <= depth))
                .count()
        } else {
            let temporary = Document {
                model_version: document.model_version.clone(),
                metadata: BTreeMap::new(),
                blocks: vec![block.clone()],
                footnotes: BTreeMap::new(),
            };
            render_terminal(&temporary).len()
        };
        offset += block_lines;
    }
    offsets
}

fn render_blocks(blocks: &[Block]) -> Vec<String> {
    let document = Document {
        model_version: "0.1".into(),
        metadata: BTreeMap::new(),
        blocks: blocks.to_vec(),
        footnotes: BTreeMap::new(),
    };
    render_terminal(&document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command};

    const SOURCE: &str = "@notmarkdown 0.1\n\n@document {\n  title: \"Rust core\"\n  language: en\n}\n\n# Rust core {#rust}\n\nA **small** document.\n\n1. First\n1. Second\n\n![Preview](asset:preview){layout=wide}\n";

    #[test]
    fn parses_the_vertical_slice() {
        let result = parse(SOURCE);
        assert!(result.is_valid(), "{:#?}", result.diagnostics);
        let document = result.document.unwrap();
        assert_eq!(document.blocks.len(), 4);
        assert_eq!(
            collect_asset_ids(&document),
            BTreeSet::from(["preview".into()])
        );
        assert!(
            render_terminal(&document)
                .join("\n")
                .contains("2.   Second")
        );
    }

    #[test]
    fn static_visual_fences_remain_lossless_inert_code_and_searchable() {
        let source = "@notmarkdown 0.1\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```vega-lite\n{\"data\":{\"values\":[{\"x\":\"A\",\"y\":1}]},\"mark\":\"bar\",\"encoding\":{\"x\":{\"field\":\"x\",\"type\":\"nominal\"},\"y\":{\"field\":\"y\",\"type\":\"quantitative\"}}}\n```\n";
        let result = parse(source);
        assert!(result.is_valid(), "{:#?}", result.diagnostics);
        let document = result.document.expect("document");
        assert!(matches!(
            &document.blocks[0],
            Block::CodeBlock {
                language: Some(language),
                text
            } if language == "mermaid" && text.contains("A --> B")
        ));
        assert_eq!(
            renderable_notation("mermaid"),
            Some(RenderableNotation::Mermaid)
        );
        assert_eq!(
            renderable_notation("vegalite"),
            Some(RenderableNotation::VegaLite)
        );
        assert_eq!(renderable_notation("Mermaid"), None);
        assert_eq!(renderable_notation("VEGA-LITE"), None);
        assert_eq!(renderable_notation("vl"), None);
        assert_eq!(search_document(&document, "flowchart", 1)[0].kind, "codeBlock");
        assert!(render_terminal(&document).join("\n").contains("mermaid source"));
    }

    #[test]
    fn mermaid_preflight_is_bounded_offline_and_noninteractive() {
        assert!(preflight_mermaid("flowchart LR\n  A --> B").is_ok());
        for unsafe_source in [
            "%%{init: { 'theme': 'dark' }}%%\nflowchart LR\nA --> B",
            "flowchart LR\nclick A href \"https://example.test\"",
            "flowchart LR\nA[![remote](icon.svg)]",
            "flowchart LR\nA[<img src=icon.svg>]",
            "---\nconfig:\n  theme: dark\n---\nflowchart LR\nA --> B",
        ] {
            let error = preflight_mermaid(unsafe_source).expect_err("unsafe Mermaid");
            assert_eq!(error.kind, StaticVisualErrorKind::UnsafeFeature);
        }
        let oversized = "x".repeat(MAX_STATIC_VISUAL_BYTES + 1);
        assert_eq!(
            preflight_mermaid(&oversized).expect_err("oversized").kind,
            StaticVisualErrorKind::SizeLimit
        );
        let too_many_lines = "\n".repeat(MAX_STATIC_VISUAL_LINES);
        assert_eq!(
            preflight_mermaid(&too_many_lines)
                .expect_err("too many lines")
                .kind,
            StaticVisualErrorKind::LineLimit
        );
    }

    #[test]
    fn vega_lite_preflight_accepts_only_values_and_safe_field_definitions() {
        let valid = r#"{
          "$schema":"https://vega.github.io/schema/vega-lite/v6.json",
          "title":"Latency",
          "data":{"values":[{"service":"API","ms":42},{"service":"Web","ms":31}]},
          "mark":"bar",
          "encoding":{
            "x":{"field":"service","type":"nominal","axis":{"title":"Service"}},
            "y":{"field":"ms","type":"quantitative","scale":{"zero":true}}
          },
          "width":640,
          "height":320
        }"#;
        assert!(preflight_vega_lite(valid, Some("bar")).is_ok());
        assert!(preflight_static_visual("vega-lite", valid).is_ok());
        assert!(preflight_vega_lite(valid, Some("line")).is_err());

        for unsafe_source in [
            r#"{"data":{"url":"https://example.test/data.json"},"mark":"bar","encoding":{"x":{"field":"x"}}}"#,
            r#"{"data":{"values":[{"x":1}]},"mark":"bar","transform":[{"calculate":"1","as":"x"}],"encoding":{"x":{"field":"x"}}}"#,
            r#"{"data":{"values":[{"x":1}]},"mark":"bar","encoding":{"x":{"field":"x","axis":{"labelExpr":"datum.label"}}}}"#,
            r#"{"data":{"values":[{"x":1}]},"mark":"bar","encoding":{"x":{"field":"x","axis":{"format":"1000000000"}}}}"#,
            r#"{"data":{"values":[{"x":1}]},"mark":{"type":"bar"},"encoding":{"x":{"field":"x"}}}"#,
        ] {
            assert!(
                preflight_vega_lite(unsafe_source, None).is_err(),
                "accepted {unsafe_source}"
            );
        }
    }

    #[test]
    fn visual_asset_media_types_participate_in_disposable_search() {
        assert!(is_searchable_media_type("text/vnd.mermaid"));
        assert!(is_searchable_media_type("application/vnd.vegalite+json"));
        assert!(is_searchable_media_type(
            "application/vnd.vegalite.v5+json"
        ));
        assert!(is_searchable_media_type(
            "application/vnd.vegalite.v6+json"
        ));
    }

    #[test]
    fn ordered_lists_reject_manual_renumbering() {
        let result = parse("@notmarkdown 0.1\n\n1. one\n2. two\n");
        assert!(!result.is_valid());
        assert_eq!(result.diagnostics[0].code, "NMD_LIST_MARKER");
    }

    #[test]
    fn invalid_source_has_no_document() {
        let result = parse("# Missing header\n");
        assert!(result.document.is_none());
        assert_eq!(result.diagnostics[0].code, "NMD_HEADER_REQUIRED");
    }

    #[test]
    fn parses_nested_tasks_and_footnotes() {
        let source = "@notmarkdown 0.1\n\n# Tasks {#tasks}\n\n- [x] Outer\n  - [ ] Inner\n\nSee [tasks](#tasks).[^note]\n\n[^note]: Supporting text.\n";
        let result = parse(source);
        assert!(result.is_valid(), "{:#?}", result.diagnostics);
        let document = result.document.unwrap();
        let Block::List { items, .. } = &document.blocks[1] else {
            panic!("expected list");
        };
        assert_eq!(items[0].checked, Some(true));
        let Block::List { items: nested, .. } = &items[0].blocks[1] else {
            panic!("expected nested list");
        };
        assert_eq!(nested[0].checked, Some(false));
        assert!(document.footnotes.contains_key("note"));
    }

    #[test]
    fn parses_structured_static_nodes_and_collects_assets() {
        let source = "@notmarkdown 0.1\n\n!diagram[Flow] {\n  type: flow\n  source: asset:diagram-source\n}\n\n!chart[Values] {\n  type: bar\n  data: asset:chart-data\n}\n\n!math[Equation] {\n  notation: tex\n  source: \"x^2\"\n}\n\n!attachment[Dataset](asset:dataset) {\n}\n";
        let result = parse(source);
        assert!(result.is_valid(), "{:#?}", result.diagnostics);
        let document = result.document.unwrap();
        assert_eq!(document.blocks.len(), 4);
        assert_eq!(
            collect_asset_ids(&document),
            BTreeSet::from([
                "chart-data".into(),
                "dataset".into(),
                "diagram-source".into(),
            ])
        );
    }

    #[test]
    fn rejects_unresolved_internal_and_footnote_references() {
        let result = parse("@notmarkdown 0.1\n\nSee [missing](#missing).[^missing]\n");
        assert!(!result.is_valid());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.code == "NMD_REFERENCE_UNRESOLVED")
        );
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.code == "NMD_FOOTNOTE_UNRESOLVED")
        );
    }

    #[test]
    fn preserves_structured_inline_semantics() {
        let source = "@notmarkdown 0.1\n\n# Result {#result}\n\n**Strong**, *emphasis*, `code`, $x^2$, [result](#result), and ![pixel](asset:pixel).\n";
        let result = parse(source);
        assert!(result.is_valid(), "{:#?}", result.diagnostics);
        let document = result.document.unwrap();
        let Block::Paragraph { children } = &document.blocks[1] else {
            panic!("expected paragraph");
        };
        assert!(
            children
                .iter()
                .any(|node| matches!(node, Inline::Strong { .. }))
        );
        assert!(
            children
                .iter()
                .any(|node| matches!(node, Inline::Emphasis { .. }))
        );
        assert!(
            children
                .iter()
                .any(|node| matches!(node, Inline::Code { .. }))
        );
        assert!(
            children
                .iter()
                .any(|node| matches!(node, Inline::MathInline { .. }))
        );
        assert!(
            children
                .iter()
                .any(|node| matches!(node, Inline::CrossReference { .. }))
        );
        assert!(
            children
                .iter()
                .any(|node| matches!(node, Inline::Image { .. }))
        );
        assert!(collect_asset_ids(&document).contains("pixel"));
    }

    #[test]
    fn parses_typed_media_fallback_attributes() {
        let source = "@notmarkdown 0.1\n\n!video[Demo](asset:demo) {\n  layout: wide\n  poster: asset:poster\n  captions.de: asset:captions-de\n  transcript: asset:transcript\n  start: 00:00:12\n}\n";
        let result = parse(source);
        assert!(result.is_valid(), "{:#?}", result.diagnostics);
        let document = result.document.unwrap();
        let Block::Media { attributes, .. } = &document.blocks[0] else {
            panic!("expected video");
        };
        assert_eq!(attributes.layout.as_deref(), Some("wide"));
        assert_eq!(attributes.poster.as_deref(), Some("poster"));
        assert_eq!(
            attributes.captions.get("de").map(String::as_str),
            Some("captions-de")
        );
        assert_eq!(attributes.transcript.as_deref(), Some("transcript"));
        assert_eq!(
            collect_asset_ids(&document),
            BTreeSet::from([
                "captions-de".into(),
                "demo".into(),
                "poster".into(),
                "transcript".into(),
            ])
        );
    }

    #[test]
    fn canonical_cdm_matches_the_typescript_reference_tree() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples/basic.nmt");
        let source = std::fs::read_to_string(&fixture).expect("read source fixture");
        let parsed = parse(&source);
        assert!(parsed.is_valid(), "{:#?}", parsed.diagnostics);
        let rust_tree = to_cdm_value(parsed.document.as_ref().expect("Rust document"))
            .expect("serialize Rust CDM");

        let node_cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/dist/cli.js");
        let output = Command::new("node")
            .arg(node_cli)
            .arg("parse")
            .arg(&fixture)
            .output()
            .expect("run TypeScript reference parser");
        assert!(
            output.status.success(),
            "reference parser failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let reference_tree: Value =
            serde_json::from_slice(&output.stdout).expect("reference CDM JSON");
        assert_eq!(rust_tree, reference_tree);

        let compact =
            to_cdm_json(parsed.document.as_ref().expect("document"), false).expect("compact CDM");
        assert!(compact.starts_with("{\"type\":\"document\",\"modelVersion\":\"0.1\""));
        assert!(!compact.contains(":null"));
    }

    #[test]
    fn canonical_cdm_matches_reference_for_every_implemented_node_family() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples/comprehensive.nmt");
        let source = std::fs::read_to_string(&fixture).expect("read comprehensive fixture");
        let parsed = parse(&source);
        assert!(parsed.is_valid(), "{:#?}", parsed.diagnostics);
        let rust_tree = to_cdm_value(parsed.document.as_ref().expect("Rust document"))
            .expect("serialize Rust CDM");

        let node_cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/dist/cli.js");
        let output = Command::new("node")
            .arg(node_cli)
            .arg("parse")
            .arg(&fixture)
            .output()
            .expect("run TypeScript reference parser");
        assert!(
            output.status.success(),
            "reference parser failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let reference_tree: Value =
            serde_json::from_slice(&output.stdout).expect("reference CDM JSON");
        assert_eq!(rust_tree, reference_tree);
    }

    #[test]
    fn derives_outline_search_index_and_visible_toc() {
        let source = "@notmarkdown 0.1\n\n# Overview {#overview}\n\n!toc{depth=2}\n\n## Installation\n\nInstall the package locally.\n\n### Internals\n\n!video[Setup demo](asset:demo) {\n  transcript: asset:setup-transcript\n}\n\n[^note]: Searchable footnote.\n";
        let parsed = parse(source);
        assert!(parsed.is_valid(), "{:#?}", parsed.diagnostics);
        let document = parsed.document.expect("document");

        let entries = outline(&document);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "/children/0");
        assert_eq!(entries[1].title, "Installation");
        assert_eq!(entries[2].level, 3);

        let index = build_search_index(&document);
        assert_eq!(index.index_version, "0.2");
        assert!(
            index
                .entries
                .iter()
                .any(|entry| entry.path.contains("/definitions/footnotes/note"))
        );
        let hits = search_index(&index, "package locally", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "paragraph");
        let fallback_hits = search_document(&document, "setup-transcript", 10);
        assert_eq!(fallback_hits[0].kind, "video");

        let cdm = to_cdm_value(&document).expect("CDM");
        assert_eq!(cdm["children"][1]["type"], "tableOfContents");
        assert_eq!(cdm["children"][1]["maxDepth"], 2);
        let rendered = render_terminal(&document).join("\n");
        assert!(rendered.contains("  • Installation"));
        assert!(!rendered.contains("    • Internals"));
    }

    #[test]
    fn indexes_textual_package_assets_and_cleans_webvtt() {
        let source = "@notmarkdown 0.1\n\n# Media\n\n!video[Demo](asset:demo) {\n  captions.en: asset:captions\n  transcript: asset:transcript\n}\n\n!attachment[Notes](asset:notes) {\n}\n";
        let document = parse(source).document.expect("document");
        let index = build_search_index_with_assets(
            &document,
            &[
                SearchAsset {
                    id: "captions".into(),
                    package_path: "assets/captions.vtt".into(),
                    media_type: "text/vtt".into(),
                    data: b"WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<c.green>Spoken ocean turbine</c>\n".to_vec(),
                },
                SearchAsset {
                    id: "demo".into(),
                    package_path: "assets/demo.webm".into(),
                    media_type: "video/webm".into(),
                    data: b"binary words are not indexed".to_vec(),
                },
                SearchAsset {
                    id: "notes".into(),
                    package_path: "assets/notes.txt".into(),
                    media_type: "text/plain".into(),
                    data: b"Calibration appendix".to_vec(),
                },
                SearchAsset {
                    id: "transcript".into(),
                    package_path: "assets/transcript.txt".into(),
                    media_type: "text/plain".into(),
                    data: b"Silent magnetic bearing".to_vec(),
                },
            ],
        );
        assert_eq!(index.index_version, "0.2");
        assert_eq!(
            index
                .entries
                .iter()
                .filter(|entry| entry.origin.is_some())
                .count(),
            3
        );
        let caption = search_index(&index, "spoken ocean", 10);
        assert_eq!(caption[0].kind, "captions");
        assert_eq!(caption[0].asset_id.as_deref(), Some("captions"));
        assert_eq!(caption[0].context, "Spoken ocean turbine");
        let attachment = search_index(&index, "calibration appendix", 10);
        assert_eq!(attachment[0].kind, "attachmentText");
        assert_eq!(attachment[0].path, "/children/2");
        assert!(search_index(&index, "binary words", 10).is_empty());
    }

    #[test]
    fn reports_invalid_utf8_and_bounded_asset_omissions() {
        let document = parse("@notmarkdown 0.1\n\n!attachment[Notes](asset:notes) {\n}\n")
            .document
            .expect("document");
        let index = build_search_index_with_assets(
            &document,
            &[
                SearchAsset {
                    id: "notes".into(),
                    package_path: "assets/invalid.txt".into(),
                    media_type: "text/plain".into(),
                    data: vec![0xff],
                },
                SearchAsset {
                    id: "notes".into(),
                    package_path: "assets/oversized.txt".into(),
                    media_type: "text/plain".into(),
                    data: vec![0; MAX_SEARCH_ASSET_BYTES + 1],
                },
            ],
        );
        assert_eq!(
            index.omissions,
            vec![
                SearchOmission {
                    asset_id: "notes".into(),
                    package_path: "assets/invalid.txt".into(),
                    reason: "invalidUtf8".into(),
                },
                SearchOmission {
                    asset_id: "notes".into(),
                    package_path: "assets/oversized.txt".into(),
                    reason: "sizeLimit".into(),
                },
            ]
        );
    }

    #[test]
    fn incremental_cache_reuses_unchanged_assets_and_invalidates_changes() {
        let source = |heading: &str| {
            format!(
                "@notmarkdown 0.1\n\n# {heading}\n\n!video[Demo](asset:demo) {{\n  captions.en: asset:captions\n  transcript: asset:transcript\n}}\n"
            )
        };
        let first_document = parse(&source("Media")).document.expect("first document");
        let assets = vec![
            CachedSearchAsset {
                id: "captions".into(),
                package_path: "assets/captions.vtt".into(),
                media_type: "text/vtt".into(),
                fingerprint: "captions-sha".into(),
                bytes: 55,
                data: Some(b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOcean current\n".to_vec()),
            },
            CachedSearchAsset {
                id: "transcript".into(),
                package_path: "assets/transcript.txt".into(),
                media_type: "text/plain".into(),
                fingerprint: "transcript-sha-1".into(),
                bytes: 14,
                data: Some(b"Silent bearing".to_vec()),
            },
        ];
        let mut cache = IncrementalSearchCache::default();
        let first = cache
            .update(&first_document, "source-1", &assets)
            .expect("first update");
        assert!(!first.stats.document_reused);
        assert_eq!(first.stats.assets_reindexed, 2);
        assert_eq!(first.stats.assets_reused, 0);

        let cached_assets = assets
            .iter()
            .cloned()
            .map(|mut asset| {
                asset.data = None;
                asset
            })
            .collect::<Vec<_>>();
        let second = cache
            .update(&first_document, "source-1", &cached_assets)
            .expect("cached update");
        assert!(second.stats.document_reused);
        assert_eq!(second.stats.assets_reindexed, 0);
        assert_eq!(second.stats.assets_reused, 2);
        assert_eq!(second.index, first.index);

        let changed_document = parse(&source("Updated media"))
            .document
            .expect("changed document");
        let moved = cache
            .update(&changed_document, "source-2", &cached_assets)
            .expect("document update");
        assert!(!moved.stats.document_reused);
        assert_eq!(moved.stats.assets_reused, 2);
        assert_eq!(
            search_index(&moved.index, "silent bearing", 1)[0]
                .section
                .as_deref(),
            Some("Updated media")
        );

        let mut changed_assets = cached_assets;
        changed_assets[1].fingerprint = "transcript-sha-2".into();
        changed_assets[1].bytes = 25;
        changed_assets[1].data = Some(b"Modular generator housing".to_vec());
        let changed = cache
            .update(&changed_document, "source-2", &changed_assets)
            .expect("asset update");
        assert!(changed.stats.document_reused);
        assert_eq!(changed.stats.assets_reused, 1);
        assert_eq!(changed.stats.assets_reindexed, 1);
        assert_eq!(
            search_index(&changed.index, "modular generator", 1)[0]
                .asset_id
                .as_deref(),
            Some("transcript")
        );

        let pruned_document = parse(
            "@notmarkdown 0.1\n\n# Updated media\n\n!video[Demo](asset:demo) {\n  transcript: asset:transcript\n}\n",
        )
        .document
        .expect("pruned document");
        let pruned = cache
            .update(&pruned_document, "source-3", &changed_assets)
            .expect("pruned update");
        assert_eq!(pruned.stats.assets_removed, 1);
        assert_eq!(pruned.stats.assets_reused, 1);
    }

    #[test]
    fn rejects_malformed_toc_directives() {
        let parsed = parse("@notmarkdown 0.1\n\n!toc{depth=9}\n");
        assert!(!parsed.is_valid());
        assert_eq!(parsed.diagnostics[0].code, "NMD_TOC_SYNTAX");
    }
}
