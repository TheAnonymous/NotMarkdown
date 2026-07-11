import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { parse } from "@notmarkdown/reference-toolchain";
import App, { cacheRepresentationIfCurrent } from "./App";
import { DocumentEditor } from "./components/DocumentEditor";
import {
  renderMermaidSvg,
  renderVegaLiteSvg
} from "./core/visual-renderers";
import type { AssetData } from "./core/container";
import type {
  BrowserLaunchQueue,
  LaunchParams
} from "./core/file-intake";
import { DOCUMENT_THEME_OPTIONS } from "./core/document-appearance";

vi.mock("./core/visual-renderers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/visual-renderers")>();
  return {
    ...actual,
    renderMermaidSvg: vi.fn(async () =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><text>Mermaid test preview</text></svg>'
    ),
    renderVegaLiteSvg: vi.fn(async () =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><text>Vega-Lite test preview</text></svg>'
    )
  };
});

const storedValues = new Map<string, string>();
const localStorage = {
  get length() {
    return storedValues.size;
  },
  clear() {
    storedValues.clear();
  },
  getItem(key: string) {
    return storedValues.get(key) ?? null;
  },
  key(index: number) {
    return [...storedValues.keys()][index] ?? null;
  },
  removeItem(key: string) {
    storedValues.delete(key);
  },
  setItem(key: string, value: string) {
    storedValues.set(key, String(value));
  }
} satisfies Storage;

Object.defineProperty(window, "localStorage", {
  value: localStorage,
  configurable: true
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("NotMarkdown Studio", () => {
  it("renders the three built-in static visuals and keeps their exact source fences", async () => {
    const mermaidFence = [
      "```mermaid",
      "flowchart LR",
      "  Draft[Draft] --> Inspect[Inspect source] --> Build[Build package] --> Verify[Verify and share]",
      "```"
    ].join("\n");
    const barChartFence = [
      "```vega-lite",
      "{",
      '  "title": "Assets in a sample package",',
      '  "data": {',
      '    "values": [',
      '      { "type": "Images", "count": 4 },',
      '      { "type": "Audio", "count": 2 },',
      '      { "type": "Video", "count": 1 },',
      '      { "type": "Data", "count": 3 }',
      "    ]",
      "  },",
      '  "mark": "bar",',
      '  "encoding": {',
      '    "x": { "field": "type", "type": "nominal", "title": "Asset type", "sort": null },',
      '    "y": { "field": "count", "type": "quantitative", "title": "Assets" }',
      "  }",
      "}",
      "```"
    ].join("\n");
    const lineChartFence = [
      "```vega-lite",
      "{",
      '  "title": "Example document progress",',
      '  "data": {',
      '    "values": [',
      '      { "stage": "Outline", "progress": 20 },',
      '      { "stage": "Draft", "progress": 50 },',
      '      { "stage": "Review", "progress": 80 },',
      '      { "stage": "Ready", "progress": 100 }',
      "    ]",
      "  },",
      '  "mark": "line",',
      '  "encoding": {',
      '    "x": { "field": "stage", "type": "ordinal", "title": "Stage", "sort": null },',
      '    "y": { "field": "progress", "type": "quantitative", "title": "Progress (%)" }',
      "  }",
      "}",
      "```"
    ].join("\n");
    const rendered = render(<App />);

    expect(
      await screen.findByRole("img", { name: "Rendered Mermaid diagram" })
    ).toBeVisible();
    expect(
      await screen.findAllByRole("img", {
        name: "Rendered Vega-Lite chart; an accessible data table follows"
      })
    ).toHaveLength(2);
    expect(rendered.container.querySelectorAll(".visual-error")).toHaveLength(0);
    expect(renderMermaidSvg).toHaveBeenCalledTimes(1);
    expect(renderMermaidSvg).toHaveBeenCalledWith(
      mermaidFence.split("\n").slice(1, -1).join("\n")
    );
    expect(renderVegaLiteSvg).toHaveBeenCalledTimes(2);
    expect(renderVegaLiteSvg).toHaveBeenNthCalledWith(
      1,
      barChartFence.split("\n").slice(1, -1).join("\n")
    );
    expect(renderVegaLiteSvg).toHaveBeenNthCalledWith(
      2,
      lineChartFence.split("\n").slice(1, -1).join("\n")
    );
    const outline = screen.getByRole("navigation", {
      name: "Automatic outline"
    });
    for (const heading of [
      "From draft to delivery",
      "Assets in a sample package",
      "Example document progress"
    ]) {
      expect(within(outline).getByRole("button", { name: heading })).toBeVisible();
    }

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull()
    );
    const editor = EditorView.findFromDOM(
      rendered.container.querySelector(".cm-editor") as HTMLElement
    );
    expect(editor).not.toBeNull();
    const source = editor!.state.doc.toString();
    expect(source.match(/^```mermaid$/gm)).toHaveLength(1);
    expect(source.match(/^```vega-lite$/gm)).toHaveLength(2);
    expect(source).toContain(mermaidFence);
    expect(source).toContain(barChartFence);
    expect(source).toContain(lineChartFence);
  });

  it("exposes all three views and keeps them navigable", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "One document. Three honest views.",
        level: 1
      })
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    expect(await screen.findByText("@notmarkdown 0.1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    expect(await screen.findByText("Document metadata")).toBeVisible();
    expect(screen.getByText("No embedded assets yet")).toBeVisible();
    expect(screen.getByText("Generated previews")).toBeVisible();
  });

  it("inserts a deferred package image and synchronizes Source and Package usage", async () => {
    const rendered = render(<App />);
    await screen.findByRole("heading", {
      name: "One document. Three honest views.",
      level: 1
    });

    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    await screen.findByText("Document metadata");
    fireEvent.change(screen.getByLabelText("New asset ID"), {
      target: { value: "rotor-image" }
    });
    fireEvent.change(screen.getByLabelText("Add file"), {
      target: {
        files: [
          new File([new Uint8Array([137, 80, 78, 71])], "rotor.png", {
            type: "image/png"
          })
        ]
      }
    });
    expect(await screen.findByText("rotor.png")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Document/ }));
    await screen.findByRole("heading", {
      name: "One document. Three honest views."
    });
    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    const dialog = await screen.findByRole("dialog", { name: "Insert image" });
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /asset:rotor-image/ })
    );
    fireEvent.change(within(dialog).getByLabelText("Alt text"), {
      target: { value: "Rotor assembly" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));

    expect(
      await screen.findByRole("img", { name: "Rotor assembly" })
    ).toHaveAttribute("src", "blob:notmarkdown-test");
    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-content")).toHaveTextContent(
        "![Rotor assembly](asset:rotor-image)"
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    const assetGrid = rendered.container.querySelector(".asset-grid");
    expect(assetGrid).not.toBeNull();
    const assetTitle = within(assetGrid as HTMLElement).getByText("rotor-image");
    const card = assetTitle.closest(".asset-card");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("used")).toBeVisible();
    expect(within(card as HTMLElement).getByText(/loaded/)).toBeVisible();
  });

  it("uploads eager images with normalized collision-safe IDs and immediate previews", async () => {
    const rendered = render(<App />);
    await screen.findByRole("heading", {
      name: "One document. Three honest views.",
      level: 1
    });
    const file = () =>
      new File([new Uint8Array([137, 80, 78, 71])], "2026 Launch.PNG", {
        type: "image/png",
        lastModified: 42
      });

    const uploadAndInsert = async (alt: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Image" }));
      const dialog = await screen.findByRole("dialog", { name: "Insert image" });
      fireEvent.change(within(dialog).getByLabelText("Choose a local image"), {
        target: { files: [file()] }
      });
      expect(
        await within(dialog).findByRole("img", {
          name: "Preview of 2026 Launch.PNG"
        })
      ).toHaveAttribute("src", "blob:notmarkdown-test");
      fireEvent.change(within(dialog).getByLabelText("Alt text"), {
        target: { value: alt }
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));
      expect(await screen.findByRole("img", { name: alt })).toHaveAttribute(
        "src",
        "blob:notmarkdown-test"
      );
    };

    await uploadAndInsert("Launch overview");
    await uploadAndInsert("Launch detail");

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await waitFor(() => {
      const source = rendered.container.querySelector(".cm-content");
      expect(source).toHaveTextContent(
        "![Launch overview](asset:image-2026-launch)"
      );
      expect(source).toHaveTextContent(
        "![Launch detail](asset:image-2026-launch-2)"
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    await screen.findByText("Document metadata");
    const assetGrid = rendered.container.querySelector(".asset-grid");
    expect(assetGrid).not.toBeNull();
    for (const id of ["image-2026-launch", "image-2026-launch-2"]) {
      const title = within(assetGrid as HTMLElement).getByText(id, {
        selector: ".asset-title strong"
      });
      const card = title.closest(".asset-card");
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText("used")).toBeVisible();
      expect(
        within(card as HTMLElement).getByText("playback · image/png")
      ).toBeVisible();
      expect(within(card as HTMLElement).getByText(/loaded/)).toBeVisible();
    }
  });

  it("does not leave source or package assets behind when an image upload fails", async () => {
    const rendered = render(<App />);
    await screen.findByRole("heading", {
      name: "One document. Three honest views.",
      level: 1
    });
    const read = vi.fn(async (): Promise<ArrayBuffer> => {
      throw new Error("local image read failed");
    });
    const file = {
      name: "broken.png",
      type: "image/png",
      size: 4,
      lastModified: 17,
      arrayBuffer: read
    } as File;

    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    const dialog = await screen.findByRole("dialog", { name: "Insert image" });
    fireEvent.change(within(dialog).getByLabelText("Choose a local image"), {
      target: { files: [file] }
    });
    fireEvent.change(within(dialog).getByLabelText("Alt text"), {
      target: { value: "Broken upload" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "local image read failed"
    );
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await waitFor(() => {
      const source = rendered.container.querySelector(".cm-content");
      expect(source).not.toHaveTextContent("asset:broken");
      expect(source).not.toHaveTextContent("Broken upload");
    });
    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    expect(await screen.findByText("No embedded assets yet")).toBeVisible();
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

  it("exposes the document theme, accent, and reading mode as data attributes", async () => {
    const rendered = render(<App />);
    await screen.findByRole("heading", {
      name: "One document. Three honest views.",
      level: 1
    });

    const workspace = rendered.container.querySelector(".document-workspace");
    expect(workspace).toHaveAttribute("data-theme", "technical");
    expect(workspace).toHaveAttribute("data-accent", "violet");
    expect(workspace).toHaveAttribute("data-reading-mode", "default");
    expect(
      screen.getByRole("button", { name: "Dyslexia-friendly" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("rewrites the document theme and synchronizes appearance across views", async () => {
    const rendered = render(<App />);
    await screen.findByRole("heading", {
      name: "One document. Three honest views.",
      level: 1
    });

    const expectedThemes = DOCUMENT_THEME_OPTIONS.map(({ label }) => label);
    const documentTheme = screen.getByRole("combobox", { name: "Theme" });
    expect(
      within(documentTheme).getAllByRole("option").map((option) => option.textContent)
    ).toEqual(expectedThemes);
    fireEvent.change(documentTheme, {
      target: { value: "midnight" }
    });
    expect(rendered.container.querySelector(".document-workspace")).toHaveAttribute(
      "data-theme",
      "midnight"
    );
    fireEvent.click(screen.getByTitle("Heading"));
    expect(rendered.container.querySelector(".document-workspace")).toHaveAttribute(
      "data-theme",
      "midnight"
    );

    fireEvent.click(screen.getByRole("button", { name: /Package/ }));
    await screen.findByText("Document metadata");
    const packageTheme = screen.getByRole("combobox", { name: "Theme" });
    expect(packageTheme).toHaveValue("midnight");
    expect(
      within(packageTheme).getAllByRole("option").map((option) => option.textContent)
    ).toEqual(expectedThemes);
    fireEvent.change(screen.getByRole("combobox", { name: "Accent" }), {
      target: { value: "green" }
    });

    fireEvent.click(screen.getByRole("button", { name: /Document/ }));
    await screen.findByRole("heading", {
      name: "One document. Three honest views."
    });
    const workspace = rendered.container.querySelector(".document-workspace");
    expect(workspace).toHaveAttribute("data-theme", "midnight");
    expect(workspace).toHaveAttribute("data-accent", "green");
    fireEvent.click(screen.getByRole("button", { name: "Dyslexia-friendly" }));
    expect(workspace).toHaveAttribute("data-reading-mode", "dyslexia");
    expect(workspace).toHaveAttribute("data-theme", "midnight");
    expect(workspace).toHaveAttribute("data-accent", "green");

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await screen.findByText("@notmarkdown 0.1");
    await waitFor(() => {
      const source = rendered.container.querySelector(".cm-content");
      expect(source).toHaveTextContent("theme: midnight");
      expect(source).toHaveTextContent("accent: green");
      expect(source).not.toHaveTextContent(/dyslexia/i);
    });
  });

  it("keeps the personal reading mode through view, document, and app remounts", async () => {
    const first = render(<App />);
    const toggle = await screen.findByRole("button", {
      name: "Dyslexia-friendly"
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(first.container.querySelector(".document-workspace")).toHaveAttribute(
      "data-reading-mode",
      "dyslexia"
    );
    await waitFor(() =>
      expect(
        window.localStorage.getItem("notmarkdown.studio.reading-mode")
      ).toBe("true")
    );

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    await screen.findByText("@notmarkdown 0.1");
    expect(first.container.querySelector(".cm-content")).not.toHaveTextContent(
      /dyslexia/i
    );
    fireEvent.click(screen.getByRole("button", { name: /Document/ }));
    expect(
      await screen.findByRole("button", { name: "Dyslexia-friendly" })
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("heading", { name: "Untitled document", level: 1 });
    expect(first.container.querySelector(".document-workspace")).toHaveAttribute(
      "data-reading-mode",
      "dyslexia"
    );

    first.unmount();
    const second = render(<App />);
    expect(
      await screen.findByRole("button", { name: "Dyslexia-friendly" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(second.container.querySelector(".document-workspace")).toHaveAttribute(
      "data-reading-mode",
      "dyslexia"
    );
  });

  it("blocks theme changes for invalid source but keeps reading mode available", async () => {
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
      const rendered = render(<App />);
      await screen.findByRole("heading", {
        name: "One document. Three honest views.",
        level: 1
      });
      await act(async () => {
        await consumer?.({
          files: [
            {
              getFile: async () =>
                new File(["not a notmarkdown document"], "invalid.nmt", {
                  type: "text/vnd.notmarkdown.source"
                })
            }
          ]
        });
      });

      expect(
        await screen.findByText(/source opened with diagnostics/i)
      ).toBeVisible();
      const theme = screen.getByRole("combobox", { name: "Theme" });
      expect(theme).toBeDisabled();
      const previousTheme = rendered.container
        .querySelector(".document-workspace")
        ?.getAttribute("data-theme");
      fireEvent.change(theme, { target: { value: "paper" } });
      expect(rendered.container.querySelector(".document-workspace")).toHaveAttribute(
        "data-theme",
        previousTheme
      );

      const toggle = screen.getByRole("button", {
        name: "Dyslexia-friendly"
      });
      expect(toggle).toBeEnabled();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(rendered.container.querySelector(".document-workspace")).toHaveAttribute(
        "data-reading-mode",
        "dyslexia"
      );

      fireEvent.click(screen.getByRole("button", { name: /Source/ }));
      await waitFor(() =>
        expect(rendered.container.querySelector(".cm-content")).toHaveTextContent(
          "not a notmarkdown document"
        )
      );
    } finally {
      Object.defineProperty(window, "launchQueue", {
        value: undefined,
        configurable: true
      });
    }
  });

  it("keeps reading mode usable when browser storage throws", async () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError");
      });
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError");
      });

    try {
      const rendered = render(<App />);
      const toggle = await screen.findByRole("button", {
        name: "Dyslexia-friendly"
      });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(getItem).toHaveBeenCalledWith("notmarkdown.studio.reading-mode");

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(rendered.container.querySelector(".document-workspace")).toHaveAttribute(
        "data-reading-mode",
        "dyslexia"
      );
      expect(setItem).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "New" }));
      await screen.findByRole("heading", {
        name: "Untitled document",
        level: 1
      });
      expect(
        screen.getByRole("button", { name: "Dyslexia-friendly" })
      ).toHaveAttribute("aria-pressed", "true");
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("does not let a stale deferred read overwrite a replaced representation", () => {
    const source = {
      path: "assets/architecture.drawio",
      fileName: "architecture.drawio",
      mediaType: "application/vnd.jgraph.mxfile",
      fingerprint: "old-source-sha",
      role: "source" as const,
      bytes: 3
    };
    const preview = {
      path: "assets/architecture.drawio.svg",
      fileName: "architecture.drawio.svg",
      mediaType: "image/svg+xml",
      fingerprint: "preview-sha",
      role: "source" as const,
      bytes: 4,
      data: new Uint8Array([4, 5, 6, 7])
    };
    const opened: AssetData = {
      id: "architecture",
      kind: "diagram",
      ...preview,
      representations: [source, preview]
    };
    const replaced: AssetData = {
      ...opened,
      representations: [
        { ...source, fingerprint: "replacement-sha" },
        preview
      ]
    };

    expect(
      cacheRepresentationIfCurrent(
        replaced,
        0,
        source,
        new Uint8Array([1, 2, 3])
      )
    ).toBeUndefined();
    expect(replaced.representations?.[0]?.data).toBeUndefined();
    expect(
      cacheRepresentationIfCurrent(
        {
          ...opened,
          representations: [
            { ...source, path: "assets/moved.drawio" },
            preview
          ]
        },
        0,
        source,
        new Uint8Array([1, 2, 3])
      )
    ).toBeUndefined();
    expect(
      cacheRepresentationIfCurrent(
        opened,
        1,
        source,
        new Uint8Array([1, 2, 3])
      )
    ).toBeUndefined();

    const cached = cacheRepresentationIfCurrent(
      opened,
      0,
      source,
      new Uint8Array([1, 2, 3])
    );
    expect(cached?.representations?.[0]?.data).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(cached?.fingerprint).toBe("preview-sha");
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
