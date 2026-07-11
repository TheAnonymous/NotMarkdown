use std::{
    collections::BTreeMap,
    io::{self, BufRead, BufReader, Write},
};

use notmarkdown_core::{Document, Severity, outline, parse};
use serde_json::{Value, json};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    let mut server = Server::default();

    while let Some(message) = read_message(&mut reader)? {
        let should_exit = message.get("method").and_then(Value::as_str) == Some("exit");
        for response in server.handle(message) {
            write_message(&mut writer, &response)?;
        }
        if should_exit {
            break;
        }
    }
    Ok(())
}

#[derive(Default)]
struct Server {
    documents: BTreeMap<String, String>,
    shutdown_requested: bool,
}

impl Server {
    fn handle(&mut self, message: Value) -> Vec<Value> {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match method {
            Some("initialize") => id
                .map(|id| response(id, initialize_result()))
                .into_iter()
                .collect(),
            Some("shutdown") => {
                self.shutdown_requested = true;
                id.map(|id| response(id, Value::Null)).into_iter().collect()
            }
            Some("exit") => Vec::new(),
            Some("textDocument/didOpen") => {
                let uri = pointer_string(&params, "/textDocument/uri");
                let text = pointer_string(&params, "/textDocument/text");
                match (uri, text) {
                    (Some(uri), Some(text)) => {
                        self.documents.insert(uri.clone(), text.clone());
                        vec![diagnostics_notification(&uri, &text)]
                    }
                    _ => Vec::new(),
                }
            }
            Some("textDocument/didChange") => {
                let uri = pointer_string(&params, "/textDocument/uri");
                let text = params
                    .pointer("/contentChanges/0/text")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                match (uri, text) {
                    (Some(uri), Some(text)) => {
                        self.documents.insert(uri.clone(), text.clone());
                        vec![diagnostics_notification(&uri, &text)]
                    }
                    _ => Vec::new(),
                }
            }
            Some("textDocument/didClose") => {
                let Some(uri) = pointer_string(&params, "/textDocument/uri") else {
                    return Vec::new();
                };
                self.documents.remove(&uri);
                vec![json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": { "uri": uri, "diagnostics": [] }
                })]
            }
            Some("textDocument/documentSymbol") => request_result(id, || {
                let uri = pointer_string(&params, "/textDocument/uri")?;
                let source = self.documents.get(&uri)?;
                Some(document_symbols(source))
            }),
            Some("textDocument/hover") => request_result(id, || {
                let uri = pointer_string(&params, "/textDocument/uri")?;
                let line = params.pointer("/position/line")?.as_u64()? as usize;
                let source = self.documents.get(&uri)?;
                Some(hover(source, line))
            }),
            Some("textDocument/completion") => request_result(id, || Some(completion_items())),
            Some("initialized") | Some("$/cancelRequest") => Vec::new(),
            Some(_) if id.is_some() => vec![error_response(
                id.expect("checked"),
                -32601,
                "Method not found",
            )],
            _ => Vec::new(),
        }
    }
}

fn initialize_result() -> Value {
    json!({
        "capabilities": {
            "textDocumentSync": { "openClose": true, "change": 1 },
            "documentSymbolProvider": true,
            "hoverProvider": true,
            "completionProvider": { "triggerCharacters": ["!", "@", "`"] }
        },
        "serverInfo": {
            "name": "notmarkdown-lsp",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

fn diagnostics_notification(uri: &str, source: &str) -> Value {
    let diagnostics: Vec<Value> = parse(source)
        .diagnostics
        .into_iter()
        .map(|item| {
            let line = item.line.saturating_sub(1);
            let column = item.column.saturating_sub(1);
            json!({
                "range": {
                    "start": { "line": line, "character": column },
                    "end": { "line": line, "character": column + 1 }
                },
                "severity": match item.severity {
                    Severity::Error => 1,
                    Severity::Warning => 2,
                },
                "code": item.code,
                "source": "notmarkdown",
                "message": item.message,
                "data": { "suggestion": item.suggestion }
            })
        })
        .collect();
    json!({
        "jsonrpc": "2.0",
        "method": "textDocument/publishDiagnostics",
        "params": { "uri": uri, "diagnostics": diagnostics }
    })
}

fn document_symbols(source: &str) -> Value {
    let parsed = parse(source);
    let Some(document) = parsed.document else {
        return json!([]);
    };
    symbols_for_document(source, &document)
}

fn symbols_for_document(source: &str, document: &Document) -> Value {
    let heading_lines: Vec<(usize, usize)> = source
        .lines()
        .enumerate()
        .filter_map(|(line, text)| {
            let trimmed = text.trim_start();
            let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
            (hashes > 0 && hashes <= 6 && trimmed.as_bytes().get(hashes) == Some(&b' '))
                .then_some((line, text.chars().count()))
        })
        .collect();
    let symbols: Vec<Value> = outline(document)
        .into_iter()
        .zip(heading_lines)
        .map(|(entry, (line, width))| {
            json!({
                "name": entry.title,
                "detail": format!("Heading {}", entry.level),
                "kind": 15,
                "range": {
                    "start": { "line": line, "character": 0 },
                    "end": { "line": line, "character": width }
                },
                "selectionRange": {
                    "start": { "line": line, "character": 0 },
                    "end": { "line": line, "character": width }
                }
            })
        })
        .collect();
    Value::Array(symbols)
}

fn hover(source: &str, line: usize) -> Value {
    let text = source.lines().nth(line).unwrap_or_default().trim();
    let description = if text.starts_with("@notmarkdown") {
        "**NotMarkdown format header** — selects the explicit source grammar version."
    } else if text.starts_with("@document") {
        "**Document metadata** — semantic title, language, theme, and accessibility metadata."
    } else if text.starts_with("!toc") {
        "**Generated contents** — derived from the current heading outline; entries are not stored."
    } else if text.starts_with('!') {
        "**Static directive** — parsed as inert document structure and never executed."
    } else if text.contains("asset:") {
        "**Embedded asset reference** — resolves a stable logical ID from the `.nmdoc` manifest."
    } else {
        "**NotMarkdown 0.1** — deterministic, static, single-file technical documents."
    };
    json!({
        "contents": { "kind": "markdown", "value": description }
    })
}

fn completion_items() -> Value {
    let items = [
        (
            "@document",
            "@document {\n  title: \"${1:Title}\"\n  language: ${2:en}\n  theme: ${3:standard}\n}",
            "Document metadata",
        ),
        ("!toc", "!toc{depth=${1:3}}", "Generated table of contents"),
        ("!note", "!note[${1:Note}]", "Static note callout"),
        (
            "!warning",
            "!warning[${1:Warning}]",
            "Static warning callout",
        ),
        (
            "!diagram",
            "!diagram[${1:Label}] {\n  type: ${2:architecture}\n  source: asset:${3:source}\n}",
            "Embedded diagram source",
        ),
        (
            "!chart",
            "!chart[${1:Label}] {\n  type: ${2:bar}\n  data: asset:${3:data}\n}",
            "Embedded chart data",
        ),
        (
            "```mermaid",
            "```mermaid\n${1:flowchart LR\n  A --> B}\n```",
            "Static Mermaid diagram source",
        ),
        (
            "```vega-lite",
            "```vega-lite\n$1\n```",
            "Static Vega-Lite values chart",
        ),
        (
            "!attachment",
            "!attachment[${1:Label}](asset:${2:file})",
            "Embedded attachment",
        ),
    ];
    Value::Array(
        items
            .into_iter()
            .map(|(label, insert_text, detail)| {
                json!({
                    "label": label,
                    "kind": 14,
                    "detail": detail,
                    "insertTextFormat": 2,
                    "insertText": insert_text
                })
            })
            .collect(),
    )
}

fn request_result<F>(id: Option<Value>, value: F) -> Vec<Value>
where
    F: FnOnce() -> Option<Value>,
{
    id.map(|id| response(id, value().unwrap_or(Value::Null)))
        .into_iter()
        .collect()
}

fn response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn pointer_string(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length header")
    })?;
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_message<W: Write>(writer: &mut W, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_with_shared_language_features() {
        let mut server = Server::default();
        let output = server.handle(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}
        }));
        assert_eq!(output[0]["result"]["serverInfo"]["name"], "notmarkdown-lsp");
        assert_eq!(
            output[0]["result"]["capabilities"]["documentSymbolProvider"],
            true
        );
    }

    #[test]
    fn publishes_diagnostics_and_recovers_on_full_sync() {
        let mut server = Server::default();
        let opened = server.handle(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": "file:///bad.nmt", "text": "# Missing header\n" } }
        }));
        assert!(
            !opened[0]["params"]["diagnostics"]
                .as_array()
                .expect("diagnostics")
                .is_empty()
        );

        let changed = server.handle(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": { "uri": "file:///bad.nmt" },
                "contentChanges": [{ "text": "@notmarkdown 0.1\n\n# Valid\n" }]
            }
        }));
        assert!(
            changed[0]["params"]["diagnostics"]
                .as_array()
                .expect("diagnostics")
                .is_empty()
        );
    }

    #[test]
    fn returns_heading_symbols_and_batteries_included_completions() {
        let source = "@notmarkdown 0.1\n\n# Alpha\n\n## Beta\n";
        let symbols = document_symbols(source);
        assert_eq!(symbols[0]["name"], "Alpha");
        assert_eq!(symbols[1]["name"], "Beta");
        let completions = completion_items();
        let items = completions.as_array().expect("items");
        assert!(items.len() >= 9);
        let diagram = items
            .iter()
            .find(|item| item["label"] == "!diagram")
            .expect("diagram completion");
        assert!(
            diagram["insertText"]
                .as_str()
                .expect("snippet")
                .contains("source: asset:")
        );
        assert!(items.iter().any(|item| item["label"] == "```mermaid"));
        assert!(items.iter().any(|item| item["label"] == "```vega-lite"));
    }
}
