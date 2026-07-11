import type {
  BlockNode,
  DocumentNode,
  InlineNode,
  Reference
} from "./types.js";

export interface OutlineEntry {
  level: number;
  title: string;
  id?: string;
  path: string;
}

export interface SearchIndex {
  indexVersion: "0.2";
  documentModelVersion: "0.1";
  entries: SearchEntry[];
  omissions: SearchOmission[];
}

export interface SearchEntry {
  path: string;
  kind: string;
  section?: string;
  origin?: "asset";
  assetId?: string;
  role?: string;
  mediaType?: string;
  packagePath?: string;
  text: string;
}

export interface SearchHit {
  path: string;
  kind: string;
  section?: string;
  origin?: "asset";
  assetId?: string;
  role?: string;
  mediaType?: string;
  packagePath?: string;
  context: string;
  score: number;
}

export interface SearchOmission {
  assetId: string;
  packagePath: string;
  reason: "sizeLimit" | "invalidUtf8";
}

export interface SearchAsset {
  id: string;
  packagePath: string;
  mediaType: string;
  data: Uint8Array;
}

export interface CachedSearchAsset extends SearchAsset {
  fingerprint: string;
}

export interface SearchCacheStats {
  generation: number;
  documentReused: boolean;
  assetsReused: number;
  assetsReindexed: number;
  assetsRemoved: number;
  entries: number;
  omissions: number;
}

export interface SearchCacheUpdate {
  index: SearchIndex;
  stats: SearchCacheStats;
}

export const MAX_SEARCH_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_SEARCH_ASSET_BYTES = 64 * 1024 * 1024;

export function outline(document: DocumentNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  visitOutline(document.children, "/children", entries);
  return entries;
}

export function buildSearchIndex(document: DocumentNode): SearchIndex {
  const entries: SearchEntry[] = [];
  const state = { section: undefined as string | undefined };
  visitSearch(document.children, "/children", state, entries);
  for (const id of Object.keys(document.definitions.footnotes).sort()) {
    const footnoteState = { section: "Footnote " + id };
    visitSearch(
      document.definitions.footnotes[id]!,
      "/definitions/footnotes/" + escapePointer(id),
      footnoteState,
      entries
    );
  }
  return {
    indexVersion: "0.2",
    documentModelVersion: document.modelVersion,
    entries,
    omissions: []
  };
}

export function buildSearchIndexWithAssets(
  document: DocumentNode,
  assets: readonly SearchAsset[]
): SearchIndex {
  return new IncrementalSearchCache().update(
    document,
    "one-shot",
    assets.map((asset, index) => ({
      ...asset,
      fingerprint: "one-shot-" + index
    }))
  ).index;
}

interface CachedAssetEntry {
  fingerprint: string;
  mediaType: string;
  text?: string;
  omission?: "invalidUtf8";
}

export class IncrementalSearchCache {
  private documentFingerprint?: string;
  private documentIndex?: SearchIndex;
  private readonly assets = new Map<string, CachedAssetEntry>();
  private generation = 0;

  update(
    document: DocumentNode,
    documentFingerprint: string,
    assets: readonly CachedSearchAsset[]
  ): SearchCacheUpdate {
    const documentReused =
      this.documentFingerprint === documentFingerprint && Boolean(this.documentIndex);
    if (!documentReused) {
      this.documentFingerprint = documentFingerprint;
      this.documentIndex = buildSearchIndex(document);
    }
    const documentIndex = this.documentIndex!;
    const index: SearchIndex = {
      indexVersion: documentIndex.indexVersion,
      documentModelVersion: documentIndex.documentModelVersion,
      entries: [...documentIndex.entries],
      omissions: []
    };
    const sites = assetSearchSites(document);
    const ordered = [...assets].sort(
      (left, right) =>
        compareText(left.id, right.id) ||
        compareText(left.packagePath, right.packagePath)
    );
    const eligible: CachedSearchAsset[] = [];
    let totalBytes = 0;
    for (const asset of ordered) {
      if (!isSearchableMediaType(asset.mediaType) || !sites.has(asset.id)) continue;
      if (
        asset.data.length > MAX_SEARCH_ASSET_BYTES ||
        totalBytes + asset.data.length > MAX_TOTAL_SEARCH_ASSET_BYTES
      ) {
        index.omissions.push({
          assetId: asset.id,
          packagePath: asset.packagePath,
          reason: "sizeLimit"
        });
        continue;
      }
      totalBytes += asset.data.length;
      eligible.push(asset);
    }

    const activeKeys = new Set(
      eligible.map((asset) => searchAssetCacheKey(asset.id, asset.packagePath))
    );
    const previousAssets = this.assets.size;
    for (const key of this.assets.keys()) {
      if (!activeKeys.has(key)) this.assets.delete(key);
    }
    const assetsRemoved = previousAssets - this.assets.size;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let assetsReused = 0;
    let assetsReindexed = 0;
    for (const asset of eligible) {
      const key = searchAssetCacheKey(asset.id, asset.packagePath);
      let cached = this.assets.get(key);
      if (
        cached?.fingerprint === asset.fingerprint &&
        cached.mediaType === asset.mediaType
      ) {
        assetsReused += 1;
      } else {
        try {
          const decoded = decoder.decode(asset.data);
          cached = {
            fingerprint: asset.fingerprint,
            mediaType: asset.mediaType,
            text: extractSearchableAssetText(decoded, asset.mediaType)
          };
        } catch {
          cached = {
            fingerprint: asset.fingerprint,
            mediaType: asset.mediaType,
            omission: "invalidUtf8"
          };
        }
        this.assets.set(key, cached);
        assetsReindexed += 1;
      }

      if (cached.omission) {
        index.omissions.push({
          assetId: asset.id,
          packagePath: asset.packagePath,
          reason: cached.omission
        });
      } else if (cached.text) {
        const site = sites.get(asset.id)!;
        index.entries.push({
          path: site.path,
          kind: assetSearchKind(site.role),
          ...(site.section ? { section: site.section } : {}),
          origin: "asset",
          assetId: asset.id,
          role: site.role,
          mediaType: asset.mediaType,
          packagePath: asset.packagePath,
          text: cached.text
        });
      }
    }

    index.omissions.sort(
      (left, right) =>
        compareText(left.assetId, right.assetId) ||
        compareText(left.packagePath, right.packagePath)
    );

    this.generation += 1;
    return {
      index,
      stats: {
        generation: this.generation,
        documentReused,
        assetsReused,
        assetsReindexed,
        assetsRemoved,
        entries: index.entries.length,
        omissions: index.omissions.length
      }
    };
  }
}

function searchAssetCacheKey(id: string, packagePath: string): string {
  return id + "\u0000" + packagePath;
}

export function isSearchableMediaType(mediaType: string): boolean {
  return [
    "text/plain",
    "text/markdown",
    "text/vtt",
    "text/csv",
    "text/tab-separated-values",
    "application/json",
    "application/yaml",
    "application/xml",
    "application/x-subrip"
  ].includes(mediaType);
}

export function searchIndex(
  index: SearchIndex,
  query: string,
  limit = 20
): SearchHit[] {
  const phrase = query.trim().toLocaleLowerCase("und");
  const terms = phrase.split(/\s+/u).filter(Boolean);
  if (!terms.length || limit <= 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    const haystack = entry.text.toLocaleLowerCase("und");
    if (!terms.every((term) => haystack.includes(term))) continue;
    let score = ["heading"].includes(entry.kind)
      ? 100
      : ["figure", "audio", "video", "attachment"].includes(entry.kind)
        ? 80
        : [
              "captions",
              "transcript",
              "chapters",
              "attachmentText",
              "sourceText",
              "dataText",
              "assetText"
            ].includes(entry.kind)
          ? 70
        : 60;
    if (haystack === phrase) score += 50;
    else if (haystack.startsWith(phrase)) score += 25;
    if (entry.section?.toLocaleLowerCase("und").includes(phrase)) score += 10;
    hits.push({
      path: entry.path,
      kind: entry.kind,
      ...(entry.section ? { section: entry.section } : {}),
      ...(entry.origin ? { origin: entry.origin } : {}),
      ...(entry.assetId ? { assetId: entry.assetId } : {}),
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      ...(entry.packagePath ? { packagePath: entry.packagePath } : {}),
      context: context(entry.text, phrase),
      score
    });
  }
  return hits
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.path, right.path) ||
        compareText(left.assetId ?? "", right.assetId ?? "") ||
        compareText(left.packagePath ?? "", right.packagePath ?? "")
    )
    .slice(0, limit);
}

export function searchDocument(
  document: DocumentNode,
  query: string,
  limit = 20
): SearchHit[] {
  return searchIndex(buildSearchIndex(document), query, limit);
}

function visitOutline(
  blocks: BlockNode[],
  base: string,
  entries: OutlineEntry[]
): void {
  blocks.forEach((block, index) => {
    const path = base + "/" + index;
    if (block.type === "heading") {
      entries.push({
        level: block.level,
        title: normalize(plainInline(block.children)),
        ...(block.id ? { id: block.id } : {}),
        path
      });
    }
    visitNested(block, path, (children, childBase) =>
      visitOutline(children, childBase, entries)
    );
  });
}

function visitSearch(
  blocks: BlockNode[],
  base: string,
  state: { section: string | undefined },
  entries: SearchEntry[]
): void {
  blocks.forEach((block, index) => {
    const path = base + "/" + index;
    if (block.type === "heading") {
      state.section = normalize(plainInline(block.children));
    }
    const searchable = searchableBlock(block);
    if (searchable) {
      const text = normalize(searchable.text);
      if (text) {
        entries.push({
          path,
          kind: searchable.kind,
          ...(state.section ? { section: state.section } : {}),
          text
        });
      }
    }
    visitNested(block, path, (children, childBase) =>
      visitSearch(children, childBase, state, entries)
    );
  });
}

interface AssetSearchSite {
  path: string;
  role: string;
  section?: string;
}

function assetSearchSites(document: DocumentNode): Map<string, AssetSearchSite> {
  const sites = new Map<string, AssetSearchSite>();
  const record = (
    id: string,
    path: string,
    role: string,
    section: string | undefined
  ): void => {
    if (!sites.has(id)) {
      sites.set(id, { path, role, ...(section ? { section } : {}) });
    }
  };
  const visitInline = (
    nodes: InlineNode[],
    path: string,
    section: string | undefined
  ): void => {
    for (const node of nodes) {
      if (node.type === "image" && node.resource.kind === "asset") {
        record(node.resource.id, path, "image", section);
      } else if (node.type === "link") {
        if (node.target.kind === "asset") {
          record(node.target.id, path, "attachment", section);
        }
        visitInline(node.children, path, section);
      } else if (
        node.type === "emphasis" ||
        node.type === "strong" ||
        node.type === "crossReference"
      ) {
        visitInline(node.children, path, section);
      }
    }
  };
  const visit = (
    blocks: BlockNode[],
    base: string,
    state: { section: string | undefined }
  ): void => {
    blocks.forEach((block, index) => {
      const path = base + "/" + index;
      if (block.type === "heading") {
        state.section = normalize(plainInline(block.children));
      }
      if (block.type === "heading" || block.type === "paragraph") {
        visitInline(block.children, path, state.section);
      } else if (block.type === "figure") {
        if (block.resource.kind === "asset") {
          record(block.resource.id, path, "image", state.section);
        }
      } else if (block.type === "audio" || block.type === "video") {
        if (block.resource.kind === "asset") {
          record(block.resource.id, path, "playback", state.section);
        }
        const attributes = block.attributes;
        if (attributes?.poster) {
          record(attributes.poster.id, path, "poster", state.section);
        }
        if (attributes?.transcript) {
          record(attributes.transcript.id, path, "transcript", state.section);
        }
        if (attributes?.chapters) {
          record(attributes.chapters.id, path, "chapters", state.section);
        }
        for (const reference of Object.values(attributes?.captions ?? {})) {
          record(reference.id, path, "captions", state.section);
        }
        visitInline(block.label, path, state.section);
      } else if (block.type === "diagram") {
        if (block.source.kind === "asset") {
          record(block.source.id, path, "source", state.section);
        }
      } else if (block.type === "chart") {
        if (block.data.kind === "asset") {
          record(block.data.id, path, "data", state.section);
        }
      } else if (block.type === "attachment") {
        if (block.resource.kind === "asset") {
          record(block.resource.id, path, "attachment", state.section);
        }
        visitInline(block.label, path, state.section);
      }
      visitNested(block, path, (children, childBase) =>
        visit(children, childBase, state)
      );
    });
  };

  visit(document.children, "/children", { section: undefined });
  for (const id of Object.keys(document.definitions.footnotes).sort()) {
    visit(
      document.definitions.footnotes[id]!,
      "/definitions/footnotes/" + escapePointer(id),
      { section: "Footnote " + id }
    );
  }
  return sites;
}

function assetSearchKind(role: string): string {
  if (role === "captions") return "captions";
  if (role === "transcript") return "transcript";
  if (role === "chapters") return "chapters";
  if (role === "attachment") return "attachmentText";
  if (role === "source") return "sourceText";
  if (role === "data") return "dataText";
  return "assetText";
}

function extractSearchableAssetText(source: string, mediaType: string): string {
  const input = source.replace(/^\uFEFF/u, "");
  if (mediaType !== "text/vtt") return normalize(input);
  const output: string[] = [];
  let skipBlock = false;
  input.split(/\r?\n|\r/u).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (index === 0 && line.startsWith("WEBVTT")) return;
    if (!line) {
      skipBlock = false;
      return;
    }
    if (skipBlock) return;
    if (
      line === "STYLE" ||
      line === "REGION" ||
      line === "NOTE" ||
      line.startsWith("NOTE ")
    ) {
      skipBlock = true;
      return;
    }
    if (line.includes("-->") || /^\d+$/u.test(line)) return;
    const visible = line
      .replace(/<[^>]*>/gu, "")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&nbsp;/gu, " ");
    if (visible.trim()) output.push(visible);
  });
  return normalize(output.join(" "));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function visitNested(
  block: BlockNode,
  path: string,
  visit: (blocks: BlockNode[], base: string) => void
): void {
  if (block.type === "blockQuote" || block.type === "callout") {
    visit(block.children, path + "/children");
  } else if (block.type === "list") {
    block.children.forEach((item, itemIndex) =>
      visit(item.children, path + "/children/" + itemIndex + "/children")
    );
  }
}

function searchableBlock(
  block: BlockNode
): { kind: string; text: string } | undefined {
  if (block.type === "heading" || block.type === "paragraph") {
    return { kind: block.type, text: plainInline(block.children) };
  }
  if (block.type === "codeBlock") {
    return { kind: block.type, text: block.text };
  }
  if (block.type === "figure") {
    return {
      kind: "figure",
      text: block.alt + " " + referenceText(block.resource)
    };
  }
  if (block.type === "audio" || block.type === "video") {
    const fallbackIds = [
      block.attributes?.poster,
      block.attributes?.transcript,
      block.attributes?.chapters,
      ...Object.values(block.attributes?.captions ?? {})
    ]
      .filter((value): value is { kind: "asset"; id: string } => Boolean(value))
      .map(referenceText);
    return {
      kind: block.type,
      text:
        plainInline(block.label) +
        " " +
        referenceText(block.resource) +
        " " +
        fallbackIds.join(" ")
    };
  }
  if (block.type === "diagram") {
    return {
      kind: "diagram",
      text: plainBlocks(block.children) + " " + referenceText(block.source)
    };
  }
  if (block.type === "chart") {
    return {
      kind: "chart",
      text:
        plainBlocks(block.children) +
        " " +
        (isReference(block.data) ? referenceText(block.data) : JSON.stringify(block.data))
    };
  }
  if (block.type === "mathBlock") {
    return { kind: "mathBlock", text: block.source };
  }
  if (block.type === "attachment") {
    return {
      kind: "attachment",
      text: plainInline(block.label) + " " + referenceText(block.resource)
    };
  }
  return undefined;
}

function plainBlocks(blocks: BlockNode[]): string {
  return blocks
    .map((block) => searchableBlock(block)?.text ?? "")
    .filter(Boolean)
    .join(" ");
}

function plainInline(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text" || node.type === "code") return node.text;
      if (
        node.type === "emphasis" ||
        node.type === "strong" ||
        node.type === "link" ||
        node.type === "crossReference"
      ) {
        return plainInline(node.children);
      }
      if (node.type === "image") return node.alt;
      if (node.type === "hardBreak") return " ";
      if (node.type === "footnoteReference") return " " + node.target + " ";
      if (node.type === "mathInline") return node.source;
      return "";
    })
    .join("");
}

function referenceText(reference: Reference): string {
  return reference.kind === "external" ? reference.uri : reference.id;
}

function isReference(value: object): value is Reference {
  return "kind" in value;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function context(text: string, phrase: string): string {
  const characters = [...text];
  if (characters.length <= 160) return text;
  const lower = text.toLocaleLowerCase("und");
  const offset = lower.indexOf(phrase);
  const match = offset < 0 ? 0 : [...lower.slice(0, offset)].length;
  const start = Math.max(0, match - 48);
  const end = Math.min(characters.length, start + 160);
  return (
    (start > 0 ? "…" : "") +
    characters.slice(start, end).join("") +
    (end < characters.length ? "…" : "")
  );
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
