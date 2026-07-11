import { describe, expect, it, vi } from "vitest";
import {
  classifyNotMarkdownFile,
  requireNotMarkdownFile,
  sharedFileUrl,
  takePendingSharedFile
} from "./file-intake";

describe("NotMarkdown file intake", () => {
  it("accepts only the two document extensions", () => {
    expect(classifyNotMarkdownFile({ name: "Report.NMDOC" })).toBe("package");
    expect(classifyNotMarkdownFile({ name: "notes.nmt" })).toBe("source");
    expect(classifyNotMarkdownFile({ name: "notes.txt" })).toBeUndefined();
    expect(() => requireNotMarkdownFile({ name: "payload.html" })).toThrow(
      /Unsupported file/
    );
  });

  it("builds a share endpoint relative to a subdirectory deployment", () => {
    expect(
      sharedFileUrl("./", "https://example.test/tools/studio/?share-target=1")
    ).toBe("https://example.test/tools/studio/__notmarkdown_share_target__");
  });

  it("takes a shared file once and keeps only a safe basename", async () => {
    const source = "@notmarkdown 0.1\n\n# Shared\n";
    const request = vi.fn(async () =>
      new Response(source, {
        headers: {
          "content-type": "text/vnd.notmarkdown.source",
          "x-notmarkdown-filename": encodeURIComponent("../Shared notes.nmt")
        }
      })
    ) as unknown as typeof fetch;

    const file = await takePendingSharedFile(request);
    expect(file.name).toBe("Shared notes.nmt");
    expect(await file.text()).toBe(source);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("__notmarkdown_share_target__"),
      { cache: "no-store" }
    );
  });

  it("reports an absent pending share without opening arbitrary content", async () => {
    const request = vi.fn(async () => new Response("gone", { status: 410 })) as
      unknown as typeof fetch;
    await expect(takePendingSharedFile(request)).rejects.toThrow(
      "No shared NotMarkdown file is waiting."
    );
  });
});
