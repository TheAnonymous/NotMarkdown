import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";

const execute = promisify(execFile);
let languageClient: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("NotMarkdown");
  context.subscriptions.push(output);

  if (vscode.workspace.isTrusted) {
    languageClient = startLanguageClient();
    context.subscriptions.push({ dispose: () => void languageClient?.stop() });
    await languageClient.start();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("notmarkdown.preview", () => openPreview()),
    vscode.commands.registerCommand("notmarkdown.inspect", (uri?: vscode.Uri) =>
      inspectPackage(uri, output)
    ),
    vscode.commands.registerCommand("notmarkdown.verify", (uri?: vscode.Uri) =>
      verifyPackage(uri, output)
    ),
    vscode.window.registerCustomEditorProvider(
      "notmarkdown.package",
      new PackageEditorProvider(output),
      { supportsMultipleEditorsPerDocument: true }
    )
  );
}

export async function deactivate() {
  await languageClient?.stop();
}

function startLanguageClient(): LanguageClient {
  const configuration = vscode.workspace.getConfiguration("notmarkdown");
  const command = configuration.get<string>("server.path", "notmarkdown-lsp");
  const serverOptions: ServerOptions = { command, args: ["--stdio"] };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "notmarkdown" }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.nmt") }
  };
  return new LanguageClient(
    "notmarkdown",
    "NotMarkdown Language Server",
    serverOptions,
    clientOptions
  );
}

async function openPreview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "notmarkdown") return;
  const panel = vscode.window.createWebviewPanel(
    "notmarkdown.preview",
    `Preview · ${editor.document.fileName.split(/[\\/]/).at(-1)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const parsed = await runTool(["parse", "--compact", editor.document.uri.fsPath]);
  const document = JSON.parse(parsed) as DocumentNode;
  panel.webview.html = documentHtml(document, panel.webview.cspSource);
}

async function inspectPackage(uri: vscode.Uri | undefined, output: vscode.OutputChannel) {
  const target = packageUri(uri);
  if (!target) return;
  const inspection = await runTool(["inspect", "--compact", target.fsPath]);
  output.replace(inspection);
  output.show(true);
}

async function verifyPackage(uri: vscode.Uri | undefined, output: vscode.OutputChannel) {
  const target = packageUri(uri);
  if (!target) return;
  const result = await runTool(["verify", "--compact", target.fsPath]);
  output.appendLine(result);
  output.show(true);
  void vscode.window.showInformationMessage("NotMarkdown package verified completely.");
}

class PackageDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose() {}
}

class PackageEditorProvider implements vscode.CustomReadonlyEditorProvider<PackageDocument> {
  constructor(private readonly output: vscode.OutputChannel) {}

  openCustomDocument(uri: vscode.Uri): PackageDocument {
    return new PackageDocument(uri);
  }

  async resolveCustomEditor(
    document: PackageDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    try {
      const source = await runTool(["inspect", "--compact", document.uri.fsPath]);
      const inspection = JSON.parse(source) as PackageInspection;
      panel.webview.options = { enableScripts: false };
      panel.webview.html = packageHtml(inspection, panel.webview.cspSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      panel.webview.html = errorHtml(message, panel.webview.cspSource);
    }
  }
}

async function runTool(args: string[]): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    throw new Error("Trust this workspace before running local NotMarkdown tools.");
  }
  const command = vscode.workspace
    .getConfiguration("notmarkdown")
    .get<string>("tool.path", "notmarkdown");
  try {
    const result = await execute(command, args, {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return result.stdout.trim();
  } catch (error) {
    const details = error as Error & { stderr?: string };
    throw new Error(details.stderr?.trim() || details.message);
  }
}

function packageUri(uri?: vscode.Uri): vscode.Uri | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  return target?.fsPath.toLowerCase().endsWith(".nmdoc") ? target : undefined;
}

interface DocumentNode {
  metadata?: { title?: string };
  children?: Array<Record<string, unknown>>;
}

interface PackageInspection {
  manifest: {
    containerProfile: string;
    mediaProfile: string;
    assets: Record<string, { kind: string; representations: Array<{ role: string; mediaType: string; bytes: number }> }>;
  };
  entries: Array<{ path: string; compression: string; compressedBytes: number; uncompressedBytes: number }>;
  validation: { structure: string; source: string; representations: string; deferredRepresentations: number };
}

function documentHtml(document: DocumentNode, cspSource: string): string {
  const title = escapeHtml(document.metadata?.title || "NotMarkdown document");
  const body = (document.children ?? []).map(renderBlock).join("");
  return page(title, body || "<p>No renderable blocks.</p>", cspSource);
}

function renderBlock(block: Record<string, unknown>): string {
  const type = String(block.type ?? "");
  if (type === "heading") {
    const level = Math.min(6, Math.max(1, Number(block.level ?? 2)));
    return `<h${level}>${inlineText(block.children)}</h${level}>`;
  }
  if (type === "paragraph") return `<p>${inlineText(block.children)}</p>`;
  if (type === "codeBlock") {
    const language = typeof block.language === "string" ? block.language : "";
    const source = escapeHtml(String(block.text ?? ""));
    if (language === "mermaid" || language === "vega-lite" || language === "vegalite") {
      const label = language === "mermaid" ? "Mermaid diagram source" : "Vega-Lite chart source";
      return `<figure class="visual-source"><figcaption>${label} · static preview is available in NotMarkdown Studio</figcaption><pre><code>${source}</code></pre></figure>`;
    }
    return `<pre><code>${source}</code></pre>`;
  }
  if (type === "thematicBreak") return "<hr>";
  if (["media", "figure", "audio", "video", "diagram", "chart", "attachment"].includes(type)) {
    const reference = block.resource ?? block.source ?? block.data;
    return `<figure><div class="asset">${escapeHtml(referenceLabel(reference))}</div><figcaption>${escapeHtml(type)}</figcaption></figure>`;
  }
  return `<section class="semantic"><strong>${escapeHtml(type || "block")}</strong></section>`;
}

function referenceLabel(value: unknown): string {
  if (!value || typeof value !== "object") return "unresolved reference";
  const reference = value as Record<string, unknown>;
  if (reference.kind === "asset" && typeof reference.id === "string") return `asset:${reference.id}`;
  if (reference.kind === "internal" && typeof reference.id === "string") return `#${reference.id}`;
  if (reference.kind === "external" && typeof reference.uri === "string") return reference.uri;
  return "unresolved reference";
}

function inlineText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (!item || typeof item !== "object") return "";
    const node = item as Record<string, unknown>;
    if (typeof node.text === "string") return escapeHtml(node.text);
    return inlineText(node.children);
  }).join("");
}

function packageHtml(inspection: PackageInspection, cspSource: string): string {
  const assets = Object.entries(inspection.manifest.assets).map(([id, asset]) => {
    const representations = asset.representations.map((item) =>
      `<li>${escapeHtml(item.role)} · ${escapeHtml(item.mediaType)} · ${formatBytes(item.bytes)}</li>`
    ).join("");
    return `<article><h3>${escapeHtml(id)}</h3><p>${escapeHtml(asset.kind)}</p><ul>${representations}</ul></article>`;
  }).join("");
  const body = `<div class="status"><span>Structure ${escapeHtml(inspection.validation.structure)}</span><span>Source ${escapeHtml(inspection.validation.source)}</span><span>${inspection.validation.deferredRepresentations} deferred</span></div><h2>Assets</h2><div class="grid">${assets || "<p>No assets.</p>"}</div><h2>Entries</h2><table><thead><tr><th>Path</th><th>Codec</th><th>Bytes</th></tr></thead><tbody>${inspection.entries.map((entry) => `<tr><td>${escapeHtml(entry.path)}</td><td>${escapeHtml(entry.compression)}</td><td>${formatBytes(entry.uncompressedBytes)}</td></tr>`).join("")}</tbody></table>`;
  return page("NotMarkdown Package", body, cspSource);
}

function errorHtml(message: string, cspSource: string): string {
  return page("Could not open package", `<p>${escapeHtml(message)}</p>`, cspSource);
}

function page(title: string, body: string, cspSource: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'"><meta name="viewport" content="width=device-width"><style>:root{color-scheme:light dark}body{max-width:940px;margin:0 auto;padding:38px;font:14px/1.6 system-ui;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}h1,h2,h3{line-height:1.2}h1{font-size:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}article,.semantic,figure,.status{padding:14px;border:1px solid var(--vscode-panel-border);border-radius:10px}.status{display:flex;gap:18px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--vscode-panel-border)}pre,.asset{padding:14px;border-radius:8px;background:var(--vscode-textCodeBlock-background)}</style><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
