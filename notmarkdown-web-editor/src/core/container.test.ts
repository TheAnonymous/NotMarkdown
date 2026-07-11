import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "fflate";
import { openPackage as openNodePackage } from "@notmarkdown/reference-toolchain";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import {
  createBrowserPackage,
  assertRepresentationLoadable,
  assetRepresentations,
  openBrowserPackage,
  openBrowserPackageFromBlob,
  openBrowserPackageFromRangeSource,
  readZip,
  selectAssetRepresentation,
  writeBrowserPackageToSink,
  writeZip,
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

  it("rejects an oversized archive before issuing a range read", async () => {
    let reads = 0;
    await expect(
      openBrowserPackageFromRangeSource({
        size: 320 * 1024 * 1024 + 1,
        async read() {
          reads += 1;
          throw new Error("must not read");
        }
      })
    ).rejects.toThrow("320 MiB browser archive limit");
    expect(reads).toBe(0);
  });

  it("rejects oversized ZIP declarations before reading entry output", async () => {
    const archive = rawZip([
      {
        path: "assets/oversized.bin",
        method: 8,
        packed: new Uint8Array([3, 0]),
        size: 128 * 1024 * 1024 + 1
      }
    ]);
    await expect(readZip(archive)).rejects.toThrow(
      "entry exceeds its browser resource limit"
    );
  });

  it("bounds Deflate output even when the ZIP header lies about its size", async () => {
    const packed = deflateSync(new Uint8Array(4096));
    const archive = rawZip([
      {
        path: "assets/header-lie.txt",
        method: 8,
        packed,
        size: 1
      }
    ]);
    await expect(readZip(archive)).rejects.toThrow(
      "Deflate output length differs from its ZIP header"
    );
  });

  it("rejects a huge Zstandard frame size before invoking the WASM decoder", async () => {
    const packed = new Uint8Array(13);
    const view = new DataView(packed.buffer);
    view.setUint32(0, 0xfd2fb528, true);
    packed[4] = 0xe0; // single segment with an eight-byte content-size field
    view.setBigUint64(5, BigInt(128 * 1024 * 1024 + 1), true);
    const archive = rawZip([
      {
        path: "assets/frame-lie.txt",
        method: 93,
        packed,
        size: 1
      }
    ]);
    await expect(readZip(archive)).rejects.toThrow(
      "Zstandard frame exceeds the browser entry limit"
    );
  });

  it("accepts bounded Zstandard content-size encodings at frame boundaries", async () => {
    for (const bytes of [0, 1, 255, 256, 65_535, 65_536]) {
      const data = new Uint8Array(bytes);
      let state = 0x9e3779b9 ^ bytes;
      for (let index = 0; index < data.length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        data[index] = state;
      }
      const archive = await writeZip([
        {
          path: `assets/zstd-${bytes}.txt`,
          data,
          compression: "zstd"
        }
      ]);
      const [entry] = await readZip(archive);
      expect(entry?.data).toEqual(data);
    }
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

  it("preserves draw.io source and SVG representations through eager, range, and deterministic rewrite", async () => {
    const visualSource = [
      "@notmarkdown 0.1",
      "",
      "!diagram[Architecture] {",
      "  type: architecture",
      "  source: asset:architecture",
      "}"
    ].join("\n");
    const drawio = new TextEncoder().encode(
      '<mxfile><diagram name="Page-1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>'
    );
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile/&gt;"><rect width="40" height="20"/></svg>'
    );
    const representations = [
      {
        fileName: "architecture.drawio.svg",
        mediaType: "image/svg+xml",
        fingerprint: "svg-session",
        role: "source" as const,
        bytes: svg.length,
        data: svg
      },
      {
        fileName: "architecture.drawio",
        mediaType: "application/vnd.jgraph.mxfile",
        fingerprint: "source-session",
        role: "source" as const,
        bytes: drawio.length,
        data: drawio
      }
    ];
    const architecture: AssetData = {
      id: "architecture",
      kind: "diagram",
      ...representations[0],
      representations
    };
    const first = await createBrowserPackage({
      source: visualSource,
      assets: [architecture],
      profile: "modern-0.1"
    });
    const second = await createBrowserPackage({
      source: visualSource,
      assets: [architecture],
      profile: "modern-0.1"
    });
    expect(first).toEqual(second);

    const eager = await openBrowserPackage(first);
    const eagerAsset = eager.assets[0]!;
    expect(eager.manifest.assets.architecture?.representations.map((item) => item.path)).toEqual([
      "assets/architecture.drawio",
      "assets/architecture.drawio.svg"
    ]);
    expect(assetRepresentations(eagerAsset)).toHaveLength(2);
    expect(
      assetRepresentations(eagerAsset).map((item) => Array.from(item.data ?? []))
    ).toEqual([Array.from(drawio), Array.from(svg)]);
    expect(selectAssetRepresentation(eagerAsset).fileName).toBe(
      "architecture.drawio.svg"
    );
    expect(eagerAsset.fileName).toBe("architecture.drawio.svg");

    const ranged = await openBrowserPackageFromBlob(new Blob([first]));
    const rangedAsset = ranged.assets[0]!;
    expect(assetRepresentations(rangedAsset).every((item) => !item.data)).toBe(true);
    expect(rangedAsset.fileName).toBe("architecture.drawio.svg");
    const rangedRepresentations = assetRepresentations(rangedAsset);
    expect(Array.from(await rangedRepresentations[0]!.load!())).toEqual(
      Array.from(drawio)
    );
    expect(Array.from(await rangedRepresentations[1]!.load!())).toEqual(
      Array.from(svg)
    );

    const rewritten = await createBrowserPackage({
      source: ranged.source,
      assets: ranged.assets,
      profile: "modern-0.1"
    });
    expect(rewritten).toEqual(first);
  });

  it("rejects oversized visual authoring before invoking a deferred loader", () => {
    let loaded = false;
    const representation = {
      fileName: "architecture.drawio",
      mediaType: "application/vnd.jgraph.mxfile",
      fingerprint: "oversized",
      role: "source" as const,
      bytes: 1024 * 1024 + 1,
      load: async () => {
        loaded = true;
        return new Uint8Array(1024 * 1024 + 1);
      }
    };
    const logical: AssetData = {
      id: "architecture",
      kind: "diagram",
      ...representation,
      representations: [representation]
    };
    expect(() => assertRepresentationLoadable(logical, representation, "author")).toThrow(
      "1 MiB"
    );
    expect(loaded).toBe(false);
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

function rawZip(
  inputs: readonly {
    path: string;
    method: 0 | 8 | 93;
    packed: Uint8Array;
    size: number;
    checksum?: number;
  }[]
): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const input of inputs) {
    const name = encoder.encode(input.path);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, input.method === 93 ? 63 : 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, input.method, true);
    localView.setUint32(14, input.checksum ?? 0, true);
    localView.setUint32(18, input.packed.length, true);
    localView.setUint32(22, input.size, true);
    localView.setUint16(26, name.length, true);
    local.push(localHeader, name, input.packed);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 63, true);
    centralView.setUint16(6, input.method === 93 ? 63 : 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, input.method, true);
    centralView.setUint32(16, input.checksum ?? 0, true);
    centralView.setUint32(20, input.packed.length, true);
    centralView.setUint32(24, input.size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + input.packed.length;
  }
  const centralBytes = joinBytes(central);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, inputs.length, true);
  view.setUint16(10, inputs.length, true);
  view.setUint32(12, centralBytes.length, true);
  view.setUint32(16, offset, true);
  return joinBytes([...local, centralBytes, eocd]);
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
