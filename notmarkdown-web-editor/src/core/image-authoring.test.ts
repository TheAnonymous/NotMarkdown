import { describe, expect, it, vi } from "vitest";
import {
  allocateImageAssetId,
  createImageAsset,
  validateImageFile
} from "./image-authoring";

const MIB = 1024 * 1024;

function mockFile(options: {
  name: string;
  type?: string;
  bytes?: Uint8Array;
  size?: number;
  lastModified?: number;
  read?: () => Promise<ArrayBuffer>;
}): File {
  const bytes = options.bytes ?? new Uint8Array();
  return {
    name: options.name,
    type: options.type ?? "",
    size: options.size ?? bytes.byteLength,
    lastModified: options.lastModified ?? 1234,
    arrayBuffer:
      options.read ??
      vi.fn(async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
      )
  } as File;
}

describe("image authoring", () => {
  it("validates image metadata with filename-first MIME inference", () => {
    expect(
      validateImageFile(
        mockFile({ name: "cover.PNG", type: "text/plain", size: 17 })
      )
    ).toEqual({
      fileName: "cover.PNG",
      mediaType: "image/png",
      kind: "image",
      role: "playback",
      bytes: 17
    });

    expect(
      validateImageFile(
        mockFile({ name: "cover.unknown", type: "image/webp", size: 9 })
      ).mediaType
    ).toBe("image/webp");
  });

  it("rejects non-images and draw.io diagrams before reading bytes", async () => {
    const textRead = vi.fn(async () => new ArrayBuffer(1));
    const text = mockFile({
      name: "notes.txt",
      type: "image/png",
      size: 1,
      read: textRead
    });
    const diagramRead = vi.fn(async () => new ArrayBuffer(1));
    const diagram = mockFile({
      name: "system.drawio.svg",
      type: "image/svg+xml",
      size: 1,
      read: diagramRead
    });

    await expect(createImageAsset(text, [])).rejects.toThrow(
      "Choose an image file."
    );
    await expect(createImageAsset(diagram, [])).rejects.toThrow(
      "Choose an image file."
    );
    expect(textRead).not.toHaveBeenCalled();
    expect(diagramRead).not.toHaveBeenCalled();
  });

  it("allocates normalized IDs and resolves collisions case-insensitively", () => {
    expect(
      allocateImageAssetId("Über Café.PNG", ["UBER-CAFE", "uber-cafe-2"])
    ).toBe("uber-cafe-3");
    expect(allocateImageAssetId("2026 launch.svg", [])).toBe(
      "image-2026-launch"
    );
    expect(allocateImageAssetId(".png", ["IMAGE"])).toBe("image-2");
    expect(allocateImageAssetId("folder/My Photo.JPEG", [])).toBe("my-photo");
  });

  it("reads once and creates an eager playback representation", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const read = vi.fn(async () => bytes.buffer.slice(0));
    const file = mockFile({
      name: "Hero.PNG",
      type: "image/png",
      bytes,
      lastModified: 5678,
      read
    });

    const asset = await createImageAsset(file, ["hero"]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(asset).toMatchObject({
      id: "hero-2",
      kind: "image",
      fileName: "Hero.PNG",
      mediaType: "image/png",
      role: "playback",
      bytes: bytes.byteLength
    });
    expect(asset.fingerprint).toMatch(/^session-image-\d+-4-5678$/);
    expect(Array.from(asset.data ?? [])).toEqual(Array.from(bytes));
    expect(asset.representations).toHaveLength(1);
    expect(asset.representations?.[0]).toMatchObject({
      fileName: "Hero.PNG",
      mediaType: "image/png",
      role: "playback",
      bytes: bytes.byteLength
    });
    expect(asset.representations?.[0]?.data).toBe(asset.data);
    expect(asset.load).toBeUndefined();
    expect(asset.openStream).toBeUndefined();
  });

  it("accepts a regular SVG as an eager image asset", async () => {
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'
    );
    const asset = await createImageAsset(
      mockFile({ name: "System overview.SVG", type: "image/svg+xml", bytes }),
      []
    );

    expect(asset).toMatchObject({
      id: "system-overview",
      kind: "image",
      fileName: "System overview.SVG",
      mediaType: "image/svg+xml",
      role: "playback",
      bytes: bytes.length
    });
    expect(Array.from(asset.data ?? [])).toEqual(Array.from(bytes));
    expect(asset.representations?.[0]?.data).toBe(asset.data);
  });

  it("applies the browser authoring size limit before reading", async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    const oversized = mockFile({
      name: "oversized.png",
      type: "image/png",
      size: 64 * MIB + 1,
      read
    });

    await expect(createImageAsset(oversized, [])).rejects.toThrow(
      "64 MiB browser materialization limit"
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("propagates read failures and rejects changed file sizes", async () => {
    const failure = new Error("local read failed");
    const failedRead = vi.fn(async (): Promise<ArrayBuffer> => {
      throw failure;
    });
    await expect(
      createImageAsset(
        mockFile({
          name: "failed.svg",
          type: "image/svg+xml",
          size: 2,
          read: failedRead
        }),
        []
      )
    ).rejects.toBe(failure);
    expect(failedRead).toHaveBeenCalledTimes(1);

    const shortRead = vi.fn(async () => new ArrayBuffer(1));
    await expect(
      createImageAsset(
        mockFile({
          name: "changed.png",
          type: "image/png",
          size: 2,
          read: shortRead
        }),
        []
      )
    ).rejects.toThrow("changed while it was loading");
    expect(shortRead).toHaveBeenCalledTimes(1);
  });
});
