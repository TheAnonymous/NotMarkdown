import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ManifestFileHandler {
  action: string;
  accept: Record<string, string[]>;
  launch_type: string;
}

interface StudioManifest {
  start_url: string;
  scope: string;
  file_handlers: ManifestFileHandler[];
  share_target: {
    action: string;
    method: string;
    enctype: string;
    params: { files: Array<{ name: string; accept: string[] }> };
  };
}

describe("PWA file integration assets", () => {
  it("declares relative package/source handlers and a local share target", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("public/manifest.webmanifest"), "utf8")
    ) as StudioManifest;

    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.file_handlers).toHaveLength(1);
    expect(manifest.file_handlers[0].action).toBe("./?file-launch=1");
    expect(manifest.file_handlers[0].launch_type).toBe("single-client");
    expect(
      manifest.file_handlers[0].accept[
        "application/vnd.notmarkdown.document+zip"
      ]
    ).toContain(".nmdoc");
    expect(
      manifest.file_handlers[0].accept["text/vnd.notmarkdown.source"]
    ).toContain(".nmt");
    expect(manifest.file_handlers[0].accept["text/plain"]).toContain(".nmt");
    expect(manifest.share_target).toMatchObject({
      action: "./share-target",
      method: "POST",
      enctype: "multipart/form-data"
    });
    expect(manifest.share_target.params.files[0].name).toBe("documents");
    expect(manifest.share_target.params.files[0].accept).toEqual(
      expect.arrayContaining([".nmdoc", ".nmt"])
    );
  });

  it("keeps shared bytes in an origin-private one-shot cache", () => {
    const worker = readFileSync(resolve("public/sw.js"), "utf8");
    expect(worker).toContain('form.getAll("documents")');
    expect(worker).toContain("caches.open(SHARE_CACHE)");
    expect(worker).toContain("await cache.delete(SHARED_FILE)");
    expect(worker).toContain("./?share-target=1");
    expect(worker).not.toContain("fetch(request)");
  });
});
