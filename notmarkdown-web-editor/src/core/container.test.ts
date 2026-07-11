import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openPackage as openNodePackage } from "@notmarkdown/reference-toolchain";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import {
  createBrowserPackage,
  openBrowserPackage,
  openBrowserPackageFromBlob,
  writeBrowserPackageToSink,
  type AssetData
} from "./container";
import {
  documentToEditorNode,
  editorNodeToSource
} from "./editor-model";

const source = [
  "@notmarkdown 0.1",
  "",
  "@document {",
  '  title: "Browser roundtrip"',
  "  language: en",
  "}",
  "",
  "# Browser editor {#browser}",
  "",
  "A **portable** document with an embedded image.",
  "",
  "![A tiny image](asset:pixel)"
].join("\n");

const asset: AssetData = {
  id: "pixel",
  fileName: "pixel.avif",
  mediaType: "image/avif",
  fingerprint: "pixel-session",
  kind: "image",
  role: "playback",
  bytes: 6,
  data: new Uint8Array([1, 7, 2, 8, 3, 9])
};

describe("browser container", () => {
  it("round trips the portable profile", async () => {
    const packed = await createBrowserPackage({
      source,
      assets: [asset],
      profile: "portable-0.1"
    });
    const opened = await openBrowserPackage(packed);
    expect(opened.manifest.containerProfile).toBe("portable-0.1");
    expect(opened.source).toContain("# Browser editor");
    expect(opened.assets[0]?.data).toEqual(asset.data);
    expect(
      opened.entries.find((entry) => entry.path === "document.nmt")?.compression
    ).toBe("deflate");
  });

  it("round trips the modern Zstandard profile", async () => {
    const first = await createBrowserPackage({
      source,
      assets: [asset],
      profile: "modern-0.1"
    });
    const second = await createBrowserPackage({
      source,
      assets: [asset],
      profile: "modern-0.1"
    });
    expect(first).toEqual(second);
    const opened = await openBrowserPackage(first);
    expect(opened.manifest.containerProfile).toBe("modern-0.1");
    expect(
      opened.entries.find((entry) => entry.path === "document.nmt")?.compression
    ).toBe("zstd");

    const openedByNode = openNodePackage(Buffer.from(first));
    expect(openedByNode.manifest.containerProfile).toBe("modern-0.1");
    expect(openedByNode.document.metadata.title).toBe("Browser roundtrip");
  });

  it("opens large packages by range and defers binary asset bytes", async () => {
    const data = new Uint8Array(512 * 1024);
    for (let index = 0; index < data.length; index++) data[index] = index * 31;
    const packed = await createBrowserPackage({
      source,
      assets: [{ ...asset, bytes: data.length, data }],
      profile: "modern-0.1"
    });
    const opened = await openBrowserPackageFromBlob(new Blob([packed]));

    expect(opened.source).toContain("# Browser editor");
    expect(opened.assets[0]?.data).toBeUndefined();
    expect(opened.rangeTelemetry?.entriesLoaded).toBe(3);
    expect(opened.rangeTelemetry!.bytesRead).toBeLessThan(128 * 1024);

    const loaded = await opened.assets[0]!.load!();
    expect(loaded.length).toBe(data.length);
    expect(loaded[314_159]).toBe(data[314_159]);
    expect(opened.rangeTelemetry?.entriesLoaded).toBe(4);
    expect(opened.rangeTelemetry!.bytesRead).toBeGreaterThan(data.length);

    await opened.assets[0]!.load!();
    expect(opened.rangeTelemetry?.entriesLoaded).toBe(4);
  });

  it("checks a deferred asset before exposing its bytes", async () => {
    const packed = await createBrowserPackage({
      source,
      assets: [asset],
      profile: "portable-0.1"
    });
    const damaged = packed.slice();
    const offset = findBytes(damaged, asset.data!);
    expect(offset).toBeGreaterThanOrEqual(0);
    damaged[offset] ^= 0xff;

    const opened = await openBrowserPackageFromBlob(new Blob([damaged]));
    expect(opened.assets[0]?.data).toBeUndefined();
    await expect(opened.assets[0]!.load!()).rejects.toThrow("Integrity check");
  });

  it("streams stored media without buffering the archive or asset", async () => {
    const data = new Uint8Array(512 * 1024);
    for (let index = 0; index < data.length; index++) data[index] = index * 17;
    const streamingAsset: AssetData = {
      ...asset,
      bytes: data.length,
      data: undefined,
      load: undefined,
      openStream: () => chunkedStream(data, 32 * 1024)
    };
    const chunks: Uint8Array[] = [];
    let closed = false;
    let aborted = false;
    let largestWrite = 0;
    const telemetry = await writeBrowserPackageToSink(
      { source, assets: [streamingAsset], profile: "modern-0.1" },
      {
        async write(chunk) {
          largestWrite = Math.max(largestWrite, chunk.length);
          chunks.push(chunk.slice());
        },
        async close() {
          closed = true;
        },
        async abort() {
          aborted = true;
          chunks.length = 0;
        }
      }
    );
    const packed = joinBytes(chunks);
    const opened = await openBrowserPackage(packed);

    expect(opened.assets[0]?.data).toEqual(data);
    expect(closed).toBe(true);
    expect(aborted).toBe(false);
    expect(largestWrite).toBeLessThanOrEqual(32 * 1024);
    expect(telemetry.outputBytes).toBe(packed.length);
    expect(telemetry.sourceAssetBytesRead).toBe(data.length * 2);
    expect(telemetry.peakBufferedEntryBytes).toBeLessThan(16 * 1024);
  });

  it("aborts an atomic sink when a streamed asset changes between passes", async () => {
    let opens = 0;
    const changingAsset: AssetData = {
      ...asset,
      data: undefined,
      load: undefined,
      openStream: () => {
        opens++;
        return chunkedStream(
          opens === 1 ? asset.data! : new Uint8Array([1, 7, 2, 8, 3, 8]),
          2
        );
      }
    };
    const chunks: Uint8Array[] = [];
    let aborted = false;
    await expect(
      writeBrowserPackageToSink(
        { source, assets: [changingAsset], profile: "modern-0.1" },
        {
          async write(chunk) {
            chunks.push(chunk.slice());
          },
          async close() {},
          async abort() {
            aborted = true;
            chunks.length = 0;
          }
        }
      )
    ).rejects.toThrow("changed while saving");
    expect(aborted).toBe(true);
    expect(chunks).toEqual([]);
  });

  it("opens a modern package produced by the Node reference toolchain", async () => {
    const bytes = await readFile(
      resolve(process.cwd(), "../NotMarkdown-example-modern-0.1.nmdoc")
    );
    const opened = await openBrowserPackage(bytes);
    expect(opened.manifest.containerProfile).toBe("modern-0.1");
    expect(opened.assets.map((item) => item.id)).toEqual(["package-flow"]);
    expect(opened.source).toContain("asset:package-flow");
  });

  it("keeps visual-editor serialization parseable", () => {
    const parsed = parse(source);
    expect(parsed.document).toBeDefined();
    const editor = documentToEditorNode(parsed.document!);
    const serialized = editorNodeToSource(editor, parsed.document!);
    const reparsed = parse(serialized);
    expect(reparsed.document).toBeDefined();
    expect(reparsed.diagnostics).toEqual([]);
  });

  it("rejects missing assets before packaging", async () => {
    await expect(
      createBrowserPackage({
        source,
        assets: [],
        profile: "portable-0.1"
      })
    ).rejects.toThrow("Missing asset pixel");
  });
});

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function chunkedStream(
  data: Uint8Array,
  chunkBytes: number
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, data.length);
      controller.enqueue(data.subarray(offset, end));
      offset = end;
    }
  });
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
