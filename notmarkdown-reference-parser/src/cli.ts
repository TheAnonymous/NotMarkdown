#!/usr/bin/env node

import { basename, dirname, extname, resolve, sep } from "node:path";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import process from "node:process";
import {
  createPackage,
  openPackage,
  PackageFormatError,
  type ContainerProfile,
  type PackageAssetInput
} from "./container.js";
import { parse } from "./parser.js";
import {
  buildSearchIndex,
  buildSearchIndexWithAssets,
  outline,
  searchIndex,
  type SearchAsset,
  type SearchIndex
} from "./navigation.js";
import type { DocumentNode } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  try {
    if (command === "parse") await parseCommand(args);
    else if (command === "outline") await outlineCommand(args);
    else if (command === "index") await indexCommand(args);
    else if (command === "search") await searchCommand(args);
    else if (command === "pack") await packCommand(args);
    else if (command === "unpack") await unpackCommand(args);
    else if (command === "inspect") await inspectCommand(args);
    else usage(2);
  } catch (error) {
    if (error instanceof PackageFormatError) {
      console.error(error.code + " " + error.message);
      process.exitCode = 1;
      return;
    }
    console.error(messageOf(error));
    process.exitCode = 2;
  }
}

async function outlineCommand(args: string[]): Promise<void> {
  const compact = takeFlag(args, "--compact");
  const file = args.shift();
  if (!file || args.length) return usage(2);
  printJson({ entries: outline(await loadDocument(file)) }, compact);
}

async function indexCommand(args: string[]): Promise<void> {
  const compact = takeFlag(args, "--compact");
  const file = args.shift();
  if (!file || args.length) return usage(2);
  printJson(await loadSearchIndex(file), compact);
}

async function searchCommand(args: string[]): Promise<void> {
  const compact = takeFlag(args, "--compact");
  const rawLimit = takeOption(args, "--limit") ?? "20";
  const limit = Number(rawLimit);
  const file = args.shift();
  const query = args.shift();
  if (
    !file ||
    !query ||
    args.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return usage(2);
  }
  printJson(
    { query, hits: searchIndex(await loadSearchIndex(file), query, limit) },
    compact
  );
}

async function parseCommand(args: string[]): Promise<void> {
  const compact = takeFlag(args, "--compact");
  const file = args.shift();
  if (!file || args.length) return usage(2);
  const source = await readFile(file, "utf8");
  const result = parse(source, { sourceName: file });
  if (!result.document) {
    printDiagnostics(file, result.diagnostics);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    JSON.stringify(result.document, null, compact ? undefined : 2) + "\n"
  );
}

async function packCommand(args: string[]): Promise<void> {
  const input = args.shift();
  if (!input) return usage(2);
  const output =
    takeOption(args, "--output") ??
    input.slice(0, Math.max(0, input.length - extname(input).length)) + ".nmdoc";
  const rawProfile = takeOption(args, "--profile") ?? "modern";
  const profile: ContainerProfile =
    rawProfile === "modern"
      ? "modern-0.1"
      : rawProfile === "portable"
        ? "portable-0.1"
        : invalidProfile(rawProfile);
  const mappings = takeRepeatedOption(args, "--asset");
  if (args.length) return usage(2);

  const source = await readFile(input, "utf8");
  const assets: PackageAssetInput[] = [];
  for (const mapping of mappings) {
    const equals = mapping.indexOf("=");
    if (equals <= 0 || equals === mapping.length - 1) {
      throw new Error("Asset mappings use --asset id=path.");
    }
    const id = mapping.slice(0, equals);
    const path = mapping.slice(equals + 1);
    assets.push({
      id,
      fileName: basename(path),
      data: await readFile(path)
    });
  }

  const packageBytes = createPackage({ source, assets, profile });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, packageBytes);
  console.log(output);
}

async function unpackCommand(args: string[]): Promise<void> {
  const input = args.shift();
  const output = takeOption(args, "--output");
  if (!input || !output || args.length) return usage(2);
  const opened = openPackage(await readFile(input));
  const root = resolve(output);
  await mkdir(root, { recursive: true });

  const paths = [
    "document.nmt",
    "manifest.json",
    ...Object.values(opened.manifest.assets).flatMap((asset) =>
      asset.representations.map((representation) => representation.path)
    )
  ];
  for (const path of paths) {
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new PackageFormatError(
        "NMD_UNPACK_PATH_UNSAFE",
        "Unsafe extraction path " + path + "."
      );
    }
    await mkdir(dirname(target), { recursive: true });
    if (path === "manifest.json") {
      await writeFile(
        target,
        JSON.stringify(opened.manifest, null, 2) + "\n",
        "utf8"
      );
    } else {
      const entry = opened.entries.get(path);
      if (!entry) {
        throw new PackageFormatError(
          "NMD_PACKAGE_ENTRY_MISSING",
          "Missing package entry " + path + "."
        );
      }
      await writeFile(target, entry.data);
    }
  }
  console.log(root);
}

async function inspectCommand(args: string[]): Promise<void> {
  const input = args.shift();
  if (!input || args.length) return usage(2);
  const opened = openPackage(await readFile(input));
  const result = {
    manifest: opened.manifest,
    entries: [...opened.entries.values()].map((entry) => ({
      path: entry.path,
      compression: entry.compression,
      compressedBytes: entry.compressedBytes,
      uncompressedBytes: entry.uncompressedBytes
    }))
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function loadDocument(file: string): Promise<DocumentNode> {
  if (extname(file).toLowerCase() === ".nmdoc") {
    return openPackage(await readFile(file)).document;
  }
  const source = await readFile(file, "utf8");
  const result = parse(source, { sourceName: file });
  if (!result.document) {
    printDiagnostics(file, result.diagnostics);
    throw new Error("Document source is invalid.");
  }
  return result.document;
}

async function loadSearchIndex(file: string): Promise<SearchIndex> {
  if (extname(file).toLowerCase() !== ".nmdoc") {
    return buildSearchIndex(await loadDocument(file));
  }
  const opened = openPackage(await readFile(file));
  const assets: SearchAsset[] = [];
  for (const id of Object.keys(opened.manifest.assets).sort()) {
    const representations = [...opened.manifest.assets[id]!.representations].sort(
      (left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    for (const representation of representations) {
      const entry = opened.entries.get(representation.path);
      if (!entry) {
        throw new PackageFormatError(
          "NMD_PACKAGE_ENTRY_MISSING",
          "Missing package entry " + representation.path + "."
        );
      }
      assets.push({
        id,
        packagePath: representation.path,
        mediaType: representation.mediaType,
        data: entry.data
      });
    }
  }
  return buildSearchIndexWithAssets(opened.document, assets);
}

function printJson(value: unknown, compact: boolean): void {
  process.stdout.write(JSON.stringify(value, null, compact ? undefined : 2) + "\n");
}

function printDiagnostics(
  file: string,
  diagnostics: ReturnType<typeof parse>["diagnostics"]
): void {
  for (const diagnostic of diagnostics) {
    const position = diagnostic.range.start;
    console.error(
      file +
        ":" +
        position.line +
        ":" +
        position.column +
        " " +
        diagnostic.code +
        " " +
        diagnostic.message
    );
    if (diagnostic.suggestion) {
      console.error("  suggestion: " + diagnostic.suggestion);
    }
  }
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("Missing value for " + name + ".");
  args.splice(index, 2);
  return value;
}

function takeRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  while (true) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

function invalidProfile(value: string): never {
  throw new Error("Unknown container profile " + value + ".");
}

function usage(exitCode: number): void {
  console.error(
    [
      "Usage:",
      "  notmarkdown parse [--compact] document.nmt",
      "  notmarkdown outline [--compact] document.nmt|document.nmdoc",
      "  notmarkdown index [--compact] document.nmt|document.nmdoc",
      "  notmarkdown search [--compact] [--limit 20] document query",
      "  notmarkdown pack document.nmt [--output file.nmdoc]",
      "      [--profile modern|portable] [--asset id=path]...",
      "  notmarkdown unpack document.nmdoc --output directory",
      "  notmarkdown inspect document.nmdoc"
    ].join("\n")
  );
  process.exitCode = exitCode;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
