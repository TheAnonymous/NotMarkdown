import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parse } from "@notmarkdown/reference-toolchain/parser";
import type { AssetData } from "../core/container";
import { PackageView } from "./PackageView";

describe("package representation workflow", () => {
  it("shows and addresses every representation independently", async () => {
    const parsed = parse(
      "@notmarkdown 0.1\n\n!diagram[Architecture] {\n  type: architecture\n  source: asset:architecture\n}\n"
    );
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
    );
    const source = new TextEncoder().encode("<mxfile><diagram/></mxfile>");
    const asset: AssetData = {
      id: "architecture",
      kind: "diagram",
      fileName: "architecture.drawio.svg",
      mediaType: "image/svg+xml",
      fingerprint: "svg",
      role: "source",
      bytes: svg.length,
      data: svg,
      representations: [
        {
          path: "assets/architecture.drawio",
          fileName: "architecture.drawio",
          mediaType: "application/vnd.jgraph.mxfile",
          fingerprint: "drawio",
          role: "source",
          bytes: source.length
        },
        {
          path: "assets/architecture.drawio.svg",
          fileName: "architecture.drawio.svg",
          mediaType: "image/svg+xml",
          fingerprint: "svg",
          role: "source",
          bytes: svg.length,
          data: svg
        }
      ]
    };
    const onLoadAsset = vi.fn(async () => source);
    render(
      <PackageView
        document={parsed.document!}
        assets={[asset]}
        assetUrls={new Map()}
        profile="modern-0.1"
        onProfileChange={() => {}}
        onAssetsChange={() => {}}
        onLoadAsset={onLoadAsset}
        onMetadataChange={() => {}}
      />
    );

    expect(screen.getByText("2 representations")).toBeInTheDocument();
    expect(screen.getByText("architecture.drawio")).toBeInTheDocument();
    expect(screen.getByText("architecture.drawio.svg")).toBeInTheDocument();
    expect(screen.getAllByText("Extract")).toHaveLength(2);
    expect(screen.getAllByText("Replace")).toHaveLength(2);
    fireEvent.click(screen.getByText("Load"));
    expect(onLoadAsset).toHaveBeenCalledWith("architecture", 0, "author");
  });
});
