import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parse } from "@notmarkdown/reference-toolchain";
import App from "./App";
import { DocumentEditor } from "./components/DocumentEditor";
import type { AssetData } from "./core/container";
import type {
  BrowserLaunchQueue,
  LaunchParams
} from "./core/file-intake";

describe("NotMarkdown Studio", () => {
  it("exposes all three views and keeps them navigable", async () => {
    render(<App />);
    expect(
      await screen.findByText("One document. Three honest views.")
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    expect(await screen.findByText("@notmarkdown 0.1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    expect(await screen.findByText("Document metadata")).toBeVisible();
    expect(screen.getByText("No embedded assets yet")).toBeVisible();
    expect(screen.getByText("Generated previews")).toBeVisible();
  });

  it("provides automatic outline and local full-text search in Document view", async () => {
    const rendered = render(<App />);
    const scoped = within(rendered.container);
    const search = await scoped.findByRole("searchbox", {
      name: "Search document and embedded text"
    });
    expect(scoped.getByRole("navigation", { name: "Automatic outline" })).toBeVisible();
    expect(
      scoped.getByRole("button", { name: "What already works" })
    ).toBeVisible();

    fireEvent.change(search, { target: { value: "portable file" } });
    const navigation = scoped.getByRole("complementary", {
      name: "Document navigation"
    });
    expect(
      await within(navigation).findByText(/keep every asset inside one portable file/i)
    ).toBeVisible();
  });

  it("searches embedded transcript text and identifies its asset", async () => {
    const parsed = parse(
      [
        "@notmarkdown 0.1",
        "",
        "# Media",
        "",
        "!video[Demo](asset:demo) {",
        "  transcript: asset:transcript",
        "}"
      ].join("\n") + "\n"
    );
    expect(parsed.document).toBeTruthy();
    const assets: AssetData[] = [
      {
        id: "transcript",
        fileName: "transcript.txt",
        mediaType: "text/plain",
        fingerprint: "transcript-session",
        kind: "attachment",
        role: "transcript",
        bytes: 46,
        data: new TextEncoder().encode("A silent magnetic bearing supports the rotor.")
      }
    ];
    const rendered = render(
      <DocumentEditor
        document={parsed.document!}
        documentFingerprint="test-source"
        assets={assets}
        assetUrls={new Map()}
        assetVersion={1}
        onChange={() => undefined}
      />
    );
    const scoped = within(rendered.container);
    const search = await scoped.findByPlaceholderText(
      "Headings, transcripts, captions…"
    );
    fireEvent.change(search, { target: { value: "silent magnetic" } });
    expect(await scoped.findByText(/silent magnetic bearing supports/i)).toBeVisible();
    expect(scoped.getByText("transcript · asset:transcript")).toBeVisible();
    expect(scoped.getByText(/Cache 0 reused · 1 rebuilt/)).toBeVisible();
    fireEvent.change(search, { target: { value: "bearing" } });
    expect(await scoped.findByText(/Cache 1 reused · 0 rebuilt/)).toBeVisible();
  });

  it("offers explicit loading for deferred inline media", async () => {
    const parsed = parse(
      ["@notmarkdown 0.1", "", "# Media", "", "![Rotor](asset:rotor)"].join("\n") + "\n"
    );
    expect(parsed.document).toBeTruthy();
    const load = vi.fn(async () => new Uint8Array([1, 2, 3]));
    render(
      <DocumentEditor
        document={parsed.document!}
        documentFingerprint="media-source"
        assets={[
          {
            id: "rotor",
            fileName: "rotor.avif",
            mediaType: "image/avif",
            fingerprint: "rotor-sha",
            kind: "image",
            role: "playback",
            bytes: 3,
            load
          }
        ]}
        assetUrls={new Map()}
        assetVersion={1}
        onLoadAsset={load}
        onChange={() => undefined}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Load image · asset:rotor" })
    );
    expect(load).toHaveBeenCalledWith("rotor");
  });

  it("opens an OS-launched source through the normal local intake path", async () => {
    let consumer: ((params: LaunchParams) => void | Promise<void>) | undefined;
    const launchQueue: BrowserLaunchQueue = {
      setConsumer(next) {
        consumer = next;
      }
    };
    Object.defineProperty(window, "launchQueue", {
      value: launchQueue,
      configurable: true
    });

    try {
      render(<App />);
      expect(consumer).toBeDefined();
      const file = new File(
        ["@notmarkdown 0.1\n\n# Launched from the system\n"],
        "system-note.nmt",
        { type: "text/vnd.notmarkdown.source" }
      );
      await act(async () => {
        await consumer?.({ files: [{ getFile: async () => file }] });
      });

      expect(screen.getByLabelText("Document filename")).toHaveValue(
        "system-note.nmdoc"
      );
      expect(
        await screen.findByText("System-launched source document opened.")
      ).toBeVisible();
    } finally {
      Object.defineProperty(window, "launchQueue", {
        value: undefined,
        configurable: true
      });
    }
  });

  it("rejects arbitrary dropped files and explains the supported fallback", async () => {
    render(<App />);
    fireEvent.drop(screen.getByRole("main", { name: "NotMarkdown Studio" }), {
      dataTransfer: {
        files: [new File(["<script>bad()</script>"], "payload.html")]
      }
    });
    expect(
      await screen.findByText(
        "Unsupported file. Open a .nmt source or .nmdoc package instead."
      )
    ).toBeVisible();
    expect(screen.getByLabelText("Document filename")).toHaveValue(
      "untitled.nmdoc"
    );
  });

  it("consumes a locally shared file only once under Strict Mode", async () => {
    const source = "@notmarkdown 0.1\n\n# Shared into Studio\n";
    const request = vi.fn(async () =>
      new Response(source, {
        headers: {
          "content-type": "text/vnd.notmarkdown.source",
          "x-notmarkdown-filename": encodeURIComponent("shared-note.nmt")
        }
      })
    );
    vi.stubGlobal("fetch", request);
    window.history.replaceState({}, "", "/?share-target=1");

    try {
      render(
        <StrictMode>
          <App />
        </StrictMode>
      );
      expect(
        await screen.findByDisplayValue("shared-note.nmdoc")
      ).toBeVisible();
      expect(
        await screen.findByText("Shared source document opened.")
      ).toBeVisible();
      expect(request).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe("");
    } finally {
      vi.unstubAllGlobals();
      window.history.replaceState({}, "", "/");
    }
  });
});
