import type { ComponentProps } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import { describe, expect, it, vi } from "vitest";
import type { AssetData } from "../core/container";
import { DocumentEditor } from "./DocumentEditor";

const source = "@notmarkdown 0.1\n\n# Images\n\nPlace images here.\n";
const parsed = parse(source);
if (!parsed.document) throw new Error("Invalid test document.");

function imageAsset(
  id: string,
  options: { data?: Uint8Array; fileName?: string } = {}
): AssetData {
  const data = options.data;
  return {
    id,
    kind: "image",
    fileName: options.fileName ?? `${id}.png`,
    mediaType: "image/png",
    fingerprint: `${id}-fingerprint`,
    role: "playback",
    bytes: data?.length ?? 4,
    ...(data ? { data } : {})
  };
}

function otherAsset(
  id: string,
  kind: "audio" | "video" | "diagram" | "attachment"
): AssetData {
  const metadata = {
    audio: {
      fileName: `${id}.ogg`,
      mediaType: "audio/ogg",
      role: "playback" as const
    },
    video: {
      fileName: `${id}.webm`,
      mediaType: "video/webm",
      role: "playback" as const
    },
    diagram: {
      fileName: `${id}.drawio.svg`,
      mediaType: "image/svg+xml",
      role: "source" as const
    },
    attachment: {
      fileName: `${id}.pdf`,
      mediaType: "application/pdf",
      role: "original" as const
    }
  }[kind];
  return {
    id,
    kind,
    ...metadata,
    fingerprint: `${id}-fingerprint`,
    bytes: 4,
    data: new Uint8Array([1, 2, 3, 4])
  };
}

function renderEditor(
  overrides: Partial<ComponentProps<typeof DocumentEditor>> = {}
) {
  const onChange = vi.fn<(nextSource: string) => void>();
  const rendered = render(
    <DocumentEditor
      document={parsed.document!}
      documentFingerprint={source}
      assets={[]}
      assetUrls={new Map()}
      assetVersion={1}
      onChange={onChange}
      {...overrides}
    />
  );
  return { ...rendered, onChange };
}

function openImageDialog() {
  const button = screen.getByRole("button", { name: "Image" });
  fireEvent.click(button);
  return {
    button,
    dialog: screen.getByRole("dialog", { name: "Insert image" })
  };
}

function selectExisting(dialog: HTMLElement, id: string) {
  fireEvent.click(
    within(dialog).getByRole("radio", { name: new RegExp(`^asset:${id}`) })
  );
}

function enterAlt(dialog: HTMLElement, alt: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Alt text" }), {
    target: { value: alt }
  });
}

describe("DocumentEditor image dialog", () => {
  it("lists only logical image assets with IDs, filenames, and available previews", () => {
    const assets = [
      imageAsset("hero", { fileName: "Hero.PNG" }),
      imageAsset("portrait", { fileName: "portrait.webp" }),
      otherAsset("sound", "audio"),
      otherAsset("movie", "video"),
      otherAsset("architecture", "diagram"),
      otherAsset("brief", "attachment")
    ];
    renderEditor({
      assets,
      assetUrls: new Map([["hero", "blob:hero-preview"]])
    });

    const { dialog } = openImageDialog();
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAccessibleName(/asset:hero.*Hero\.PNG/i);
    expect(radios[1]).toHaveAccessibleName(/asset:portrait.*portrait\.webp/i);
    expect(
      within(dialog).getByRole("img", { name: "Preview of asset:hero" })
    ).toHaveAttribute("src", "blob:hero-preview");
    for (const id of ["sound", "movie", "architecture", "brief"]) {
      expect(
        within(dialog).queryByRole("radio", {
          name: new RegExp(`^asset:${id}`)
        })
      ).not.toBeInTheDocument();
    }
  });

  it("loads a deferred existing image before changing the source", async () => {
    let resolveLoad!: (bytes: Uint8Array) => void;
    const pendingLoad = new Promise<Uint8Array>((resolve) => {
      resolveLoad = resolve;
    });
    const events: string[] = [];
    const onLoadAsset = vi.fn(() => {
      events.push("load");
      return pendingLoad;
    });
    const rendered = renderEditor({
      assets: [imageAsset("rotor")],
      onLoadAsset
    });
    rendered.onChange.mockImplementation(() => events.push("change"));

    const { dialog } = openImageDialog();
    selectExisting(dialog, "rotor");
    enterAlt(dialog, "Rotor assembly");
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));

    expect(onLoadAsset).toHaveBeenCalledWith("rotor");
    expect(rendered.onChange).not.toHaveBeenCalled();
    expect(events).toEqual(["load"]);

    await act(async () => {
      resolveLoad(new Uint8Array([1, 2, 3, 4]));
      await pendingLoad;
    });

    await waitFor(() => expect(rendered.onChange).toHaveBeenCalledTimes(1));
    expect(rendered.onChange.mock.calls[0]?.[0]).toContain(
      "![Rotor assembly](asset:rotor)"
    );
    expect(events).toEqual(["load", "change"]);
    expect(
      screen.queryByRole("dialog", { name: "Insert image" })
    ).not.toBeInTheDocument();
  });

  it("keeps the dialog open and source unchanged when an existing image fails to load", async () => {
    const onLoadAsset = vi.fn(async () => {
      throw new Error("local image read failed");
    });
    const { onChange } = renderEditor({
      assets: [imageAsset("broken")],
      onLoadAsset
    });

    const { dialog } = openImageDialog();
    selectExisting(dialog, "broken");
    enterAlt(dialog, "Broken image");
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));

    expect(
      await within(dialog).findByRole("alert")
    ).toHaveTextContent("local image read failed");
    expect(onLoadAsset).toHaveBeenCalledWith("broken");
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("requires alt text unless Decorative is explicitly selected", async () => {
    const { onChange } = renderEditor({
      assets: [imageAsset("flourish", { data: new Uint8Array([1]) })]
    });

    const { dialog } = openImageDialog();
    selectExisting(dialog, "flourish");
    const insert = within(dialog).getByRole("button", { name: "Insert" });
    const alt = within(dialog).getByRole("textbox", { name: "Alt text" });
    expect(insert).toBeDisabled();

    fireEvent.change(alt, { target: { value: "   " } });
    expect(insert).toBeDisabled();
    fireEvent.change(alt, { target: { value: "Purely visual flourish" } });
    expect(insert).toBeEnabled();

    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Decorative" })
    );
    expect(alt).toBeDisabled();
    expect(insert).toBeEnabled();
    fireEvent.click(insert);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]?.[0]).toContain(
      "![](asset:flourish){decorative=true}"
    );
    expect(onChange.mock.calls[0]?.[0]).not.toContain("Purely visual flourish");
  });

  it("closes without changes on Cancel, Escape, or backdrop click and restores focus", async () => {
    const { onChange } = renderEditor({
      assets: [imageAsset("hero", { data: new Uint8Array([1]) })]
    });
    const imageButton = screen.getByRole("button", { name: "Image" });

    imageButton.focus();
    let opened = openImageDialog();
    fireEvent.click(within(opened.dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(imageButton).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Insert image" })
    ).not.toBeInTheDocument();

    opened = openImageDialog();
    fireEvent.keyDown(opened.dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(imageButton).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Insert image" })
    ).not.toBeInTheDocument();

    opened = openImageDialog();
    fireEvent.click(opened.dialog);
    await waitFor(() => expect(imageButton).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Insert image" })
    ).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables image insertion while the source is invalid", () => {
    const { onChange } = renderEditor({ sourceValid: false });
    const button = screen.getByRole("button", { name: "Image" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Resolve source diagnostics before inserting an image"
    );
    fireEvent.click(button);
    expect(
      screen.queryByRole("dialog", { name: "Insert image" })
    ).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows upload callback failures without changing the source", async () => {
    const failure = new Error("could not read the selected file");
    const onAddImageAsset = vi.fn(async () => {
      throw failure;
    });
    const { onChange } = renderEditor({ onAddImageAsset });
    const file = new File([new Uint8Array([137, 80, 78, 71])], "Local.PNG", {
      type: "image/png"
    });

    const { dialog } = openImageDialog();
    fireEvent.change(
      within(dialog).getByLabelText("Choose a local image"),
      { target: { files: [file] } }
    );
    expect(
      await within(dialog).findByRole("img", { name: "Preview of Local.PNG" })
    ).toHaveAttribute("src", "blob:notmarkdown-test");
    enterAlt(dialog, "Locally selected image");
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));

    expect(
      await within(dialog).findByRole("alert")
    ).toHaveTextContent(failure.message);
    expect(onAddImageAsset).toHaveBeenCalledWith(file);
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("can reference the same existing image more than once", async () => {
    const { onChange } = renderEditor({
      assets: [imageAsset("shared", { data: new Uint8Array([1]) })]
    });

    const insertShared = async (alt: string) => {
      const { dialog } = openImageDialog();
      selectExisting(dialog, "shared");
      enterAlt(dialog, alt);
      fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Insert image" })
        ).not.toBeInTheDocument()
      );
    };

    await insertShared("First use");
    await insertShared("Second use");

    expect(onChange).toHaveBeenCalledTimes(2);
    const latest = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(latest).toContain("![First use](asset:shared)");
    expect(latest).toContain("![Second use](asset:shared)");
    expect(latest.match(/asset:shared/g)).toHaveLength(2);
  });
});
