import { createHash } from "node:crypto";
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

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");
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

  it("bundles the pinned OpenDyslexic fonts without a network dependency", () => {
    const stylesheet = readFileSync(
      resolve("public/accessibility-fonts.css"),
      "utf8"
    );

    expect(stylesheet.match(/@font-face/g)).toHaveLength(2);
    expect(stylesheet).toContain('font-family: "OpenDyslexic"');
    expect(stylesheet).toContain(
      'url("./fonts/OpenDyslexic-Regular.woff2") format("woff2")'
    );
    expect(stylesheet).toContain(
      'url("./fonts/OpenDyslexic-Bold.woff2") format("woff2")'
    );
    expect(stylesheet).toContain("font-weight: 400");
    expect(stylesheet).toContain("font-weight: 700");
    expect(stylesheet.match(/font-display: swap/g)).toHaveLength(2);
    expect(stylesheet).not.toMatch(/(?:https?:|@import)/i);

    const pinnedFonts = [
      {
        file: "OpenDyslexic-Regular.woff2",
        hash: "0441bc21071e42db57c217f93fbc48d3b55a2987c02814c94dc93621c42e8695"
      },
      {
        file: "OpenDyslexic-Bold.woff2",
        hash: "b534a0b84ef3cca941ebdb506ce3f4e0010aa4ef881271bac8b6959dbf694fbf"
      }
    ];
    for (const { file, hash } of pinnedFonts) {
      const path = resolve("public/fonts", file);
      expect(readFileSync(path).subarray(0, 4).toString("ascii")).toBe("wOF2");
      expect(sha256(path)).toBe(hash);
    }
  });

  it("pre-caches the accessibility font assets in the v4 app shell", () => {
    const worker = readFileSync(resolve("public/sw.js"), "utf8");

    expect(worker).toContain('const APP_CACHE = "notmarkdown-studio-v4"');
    expect(worker).not.toContain("notmarkdown-studio-v3");
    for (const asset of [
      "accessibility-fonts.css",
      "fonts/OpenDyslexic-Regular.woff2",
      "fonts/OpenDyslexic-Bold.woff2"
    ]) {
      expect(worker).toContain(`new URL("${asset}", SCOPE).href`);
    }
  });

  it("inventories the pinned font and ships its complete OFL license", () => {
    const notices = readFileSync(resolve("../THIRD_PARTY_NOTICES.md"), "utf8");
    const license = readFileSync(
      resolve("../LICENSES/OFL-1.1.txt"),
      "utf8"
    );

    expect(notices).toContain("OpenDyslexic");
    expect(notices).toContain(
      "1824da5c0e41dc3e13ffc7f3a636dcaf695d61b7"
    );
    expect(notices).toContain("SIL-OFL-1.1");
    expect(notices).toContain("LICENSES/OFL-1.1.txt");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license).toContain("PERMISSION & CONDITIONS");
    expect(license).toContain("TERMINATION");
    expect(license).toContain("DISCLAIMER");
  });
});
