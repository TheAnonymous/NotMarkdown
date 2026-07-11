import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeDocumentAccent,
  normalizeDocumentTheme
} from "./document-appearance";

const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
const LIGHT_ACCENTS = {
  violet: ["#5d4ce0", "#eeecff"],
  blue: ["#1d5f9a", "#e8f2fa"],
  green: ["#167052", "#e7f5ee"],
  orange: ["#9b4e00", "#fff0df"],
  neutral: ["#4f5661", "#edf0f3"]
} as const;
const MIDNIGHT_ACCENTS = {
  violet: ["#aa9fff", "#2e2854"],
  blue: ["#78bff2", "#16364f"],
  green: ["#69d5ad", "#153b31"],
  orange: ["#f0ae69", "#4a2e16"],
  neutral: ["#c4cad2", "#313740"]
} as const;

describe("document appearance presets", () => {
  it("normalizes every supported theme and rejects unsupported metadata", () => {
    for (const theme of [
      "standard",
      "paper",
      "technical",
      "minimal",
      "sepia",
      "midnight",
      "high-contrast"
    ]) {
      expect(normalizeDocumentTheme(theme)).toBe(theme);
    }
    expect(normalizeDocumentTheme("dyslexia")).toBe("standard");
    expect(normalizeDocumentAccent("green")).toBe("green");
    expect(normalizeDocumentAccent("magenta")).toBe("violet");
  });

  it("defines the requested theme and reading-mode typography", () => {
    const standard = declarationsFor('[data-theme="standard"]');
    const paper = declarationsFor('[data-theme="paper"]');
    const technical = declarationsFor('[data-theme="technical"]');
    const minimal = declarationsFor('[data-theme="minimal"]');
    const sepia = declarationsFor('[data-theme="sepia"]');
    const midnight = declarationsFor('[data-theme="midnight"]');
    const highContrast = declarationsFor('[data-theme="high-contrast"]');
    const dyslexia = declarationsFor('[data-reading-mode="dyslexia"]');

    expect(standard["--document-paper"]).toBe("#ffffff");
    expect(standard["--document-ink"]).toBe("#282936");
    expect(standard["--document-body-font"]).toContain("Georgia");
    expect(standard["--document-heading-font"]).toContain("ui-sans-serif");

    expect(paper["--document-paper"]).toBe("#fffaf0");
    expect(paper["--document-ink"]).toBe("#302a24");
    expect(paper["--document-heading-font"]).toContain("Georgia");

    expect(technical["--document-paper"]).toBe("#f8fafc");
    expect(technical["--document-ink"]).toBe("#17202a");
    expect(technical["--document-body-font"]).toContain("ui-sans-serif");

    expect(minimal).toMatchObject({
      "--document-paper": "#ffffff",
      "--document-canvas": "#f4f5f7",
      "--document-ink": "#20242b",
      "--document-muted": "#59616c",
      "--document-border": "#e2e6ea",
      "--document-surface-soft": "#f8fafb",
      "--document-font-size": "16.5px",
      "--document-line-height": "1.7",
      "--document-code-background": "#eef2f5",
      "--document-code-ink": "#344050",
      "--document-code-block-background": "#18202a",
      "--document-code-block-ink": "#f7f9fb"
    });
    expect(minimal["--document-body-font"]).toContain("ui-sans-serif");

    expect(sepia).toMatchObject({
      "--document-paper": "#f5ecd8",
      "--document-canvas": "#ded1b8",
      "--document-ink": "#3a2f25",
      "--document-muted": "#675a4d",
      "--document-border": "#cfc0a1",
      "--document-surface-soft": "#eee1c5",
      "--document-font-size": "17.5px",
      "--document-line-height": "1.8",
      "--document-paragraph-gap": "24px",
      "--document-code-background": "#e8dcc0",
      "--document-code-ink": "#5a3d25",
      "--document-code-block-background": "#2f281f",
      "--document-code-block-ink": "#fff4dc"
    });
    expect(sepia["--document-body-font"]).toContain("Georgia");

    expect(midnight).toMatchObject({
      "--document-paper": "#141821",
      "--document-canvas": "#090c12",
      "--document-ink": "#eef2f7",
      "--document-muted": "#b8c0ca",
      "--document-border": "#374151",
      "--document-surface-soft": "#1d2430",
      "--document-font-size": "16.5px",
      "--document-line-height": "1.7",
      "--document-code-background": "#242d3a",
      "--document-code-ink": "#eef2f7",
      "--document-code-block-background": "#0c1017",
      "--document-code-block-ink": "#f5f7fa",
      "--document-warning-border": "#8f6632",
      "--document-warning-accent": "#f0ae69",
      "--document-warning-background": "#3b2b18",
      "--document-error": "#ff9a9a"
    });
    expect(midnight["--document-body-font"]).toContain("ui-sans-serif");

    expect(highContrast).toMatchObject({
      "--document-paper": "#ffffff",
      "--document-canvas": "#d9d9d9",
      "--document-ink": "#000000",
      "--document-muted": "#333333",
      "--document-border": "#000000",
      "--document-surface-soft": "#ffffff",
      "--document-font-size": "17px",
      "--document-line-height": "1.7",
      "--document-code-background": "#ffffff",
      "--document-code-ink": "#000000",
      "--document-code-block-background": "#000000",
      "--document-code-block-ink": "#ffffff",
      "--document-warning-border": "#000000",
      "--document-warning-accent": "#000000",
      "--document-warning-background": "#ffffff",
      "--document-error": "#000000",
      "--document-border-width": "2px",
      "--document-shadow": "none"
    });
    expect(highContrast["--document-body-font"]).toContain("ui-sans-serif");

    expect(dyslexia).toMatchObject({
      "--document-paper": "#fff9df",
      "--document-ink": "#1f2933",
      "--document-font-size": "18px",
      "--document-line-height": "1.65",
      "--document-reading-width": "65ch",
      "--document-heading-letter-spacing": "0",
      "--document-warning-border": "#f2d8a8",
      "--document-warning-accent": "#dc9425",
      "--document-warning-background": "#fff9ef",
      "--document-error": "#a53c3c"
    });
    expect(dyslexia["--document-body-font"]).toContain("OpenDyslexic");
    expect(dyslexia["--document-letter-spacing"]).not.toBe("normal");
    expect(dyslexia["--document-word-spacing"]).not.toBe("normal");
    expect(stylesheet).toContain(
      '.document-workspace[data-reading-mode="dyslexia"] .ProseMirror p em'
    );

    for (const [accent, [foreground, surface]] of Object.entries(
      LIGHT_ACCENTS
    )) {
      expect(declarationsFor(`[data-accent="${accent}"]`)).toMatchObject({
        "--document-accent": foreground,
        "--document-accent-soft": surface
      });
    }
  });

  it("uses AA-safe Midnight accents and restores the semantic accent in dyslexia mode", () => {
    for (const [accent, [foreground, surface]] of Object.entries(
      MIDNIGHT_ACCENTS
    )) {
      const midnightSelector = `[data-theme="midnight"][data-accent="${accent}"]`;
      const dyslexiaSelector = `[data-reading-mode="dyslexia"][data-accent="${accent}"]`;
      expect(declarationsFor(midnightSelector)).toMatchObject({
        "--document-accent": foreground,
        "--document-accent-soft": surface
      });
      expect(declarationsFor(dyslexiaSelector)).toMatchObject({
        "--document-accent": LIGHT_ACCENTS[accent as keyof typeof LIGHT_ACCENTS][0],
        "--document-accent-soft":
          LIGHT_ACCENTS[accent as keyof typeof LIGHT_ACCENTS][1]
      });
      expect(stylesheet.indexOf(dyslexiaSelector)).toBeGreaterThan(
        stylesheet.indexOf(midnightSelector)
      );
    }

    expect(stylesheet.indexOf('[data-reading-mode="dyslexia"]')).toBeGreaterThan(
      stylesheet.indexOf('[data-theme="midnight"]')
    );

    const midnight = declarationsFor('[data-theme="midnight"]');
    const dyslexia = declarationsFor('[data-reading-mode="dyslexia"]');
    expect(
      contrast(
        midnight["--document-ink"]!,
        midnight["--document-warning-background"]!
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(
        dyslexia["--document-ink"]!,
        dyslexia["--document-warning-background"]!
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(declarationsFor("\n.nmd-callout.warning {")).toMatchObject({
      "border-color": "var(--document-warning-border)",
      "border-left-color": "var(--document-warning-accent)",
      background: "var(--document-warning-background)"
    });
  });

  it("keeps every rendered text palette at WCAG AA contrast", () => {
    const standard = declarationsFor('[data-theme="standard"]');
    const lightAppearances = [
      "standard",
      "paper",
      "technical",
      "minimal",
      "sepia",
      "high-contrast"
    ].map((theme) => ({
      appearance: {
        ...standard,
        ...declarationsFor(`[data-theme="${theme}"]`)
      },
      accents: LIGHT_ACCENTS
    }));
    const appearances = [
      ...lightAppearances,
      {
        appearance: {
          ...standard,
          ...declarationsFor('[data-theme="midnight"]')
        },
        accents: MIDNIGHT_ACCENTS
      },
      {
        appearance: {
          ...standard,
          ...declarationsFor('[data-reading-mode="dyslexia"]')
        },
        accents: LIGHT_ACCENTS
      }
    ];

    for (const { appearance, accents } of appearances) {
      for (const [foreground, background] of [
        ["--document-ink", "--document-paper"],
        ["--document-heading", "--document-paper"],
        ["--document-muted", "--document-paper"],
        ["--document-ink", "--document-surface-soft"],
        ["--document-muted", "--document-surface-soft"],
        ["--document-code-ink", "--document-code-background"],
        ["--document-code-block-ink", "--document-code-block-background"]
      ] as const) {
        expect(
          contrast(appearance[foreground]!, appearance[background]!),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }

      for (const [accentForeground, accentSurface] of Object.values(accents)) {
        for (const background of [
          appearance["--document-paper"]!,
          appearance["--document-surface-soft"]!,
          accentSurface
        ]) {
          expect(
            contrast(accentForeground, background),
            `${accentForeground} on ${background}`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      for (const background of [
        appearance["--document-paper"]!,
        appearance["--document-surface-soft"]!
      ]) {
        expect(
          contrast(appearance["--document-error"]!, background),
          `${appearance["--document-error"]} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("applies high-contrast borders and preserves unfiltered white visual output in Midnight", () => {
    for (const selector of [
      "\n.document-navigation {",
      "\n.document-navigation input {",
      "\n.format-toolbar {",
      "\n.document-paper {",
      "\n.nmd-toc {",
      "\n.ProseMirror pre {",
      "\n.nmd-callout {",
      "\n.nmd-media-node.rendered {",
      "\n.nmd-static-visual.rendered {",
      "\n.static-visual-output {"
    ]) {
      const declarations = declarationsFor(selector);
      const border =
        declarations.border ??
        declarations["border-right"] ??
        declarations["border-bottom"];
      expect(border, selector).toContain("var(--document-border-width)");
    }
    expect(declarationsFor("\n.chart-data-summary th,")["border"]).toContain(
      "var(--document-border-width)"
    );

    expect(
      declarationsFor(
        '[data-theme="midnight"] .static-visual-output'
      )
    ).toMatchObject({
      "border-color": "#dfe1e8",
      background: "#ffffff"
    });
    expect(declarationsFor("\n.static-visual-output img")["filter"]).toBe(
      "none"
    );
    expect(declarationsFor(".visual-error")["color"]).toBe(
      "var(--document-error)"
    );
    expect(stylesheet).not.toMatch(/filter\s*:\s*invert/i);

    const midnightStatus = declarationsFor(
      '[data-theme="midnight"] .static-visual-output .visual-status'
    )["color"]!;
    const midnightError = declarationsFor(
      '[data-theme="midnight"] .static-visual-output .visual-error'
    )["color"]!;
    expect(contrast(midnightStatus, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(midnightError, "#ffffff")).toBeGreaterThanOrEqual(4.5);

    expect(
      declarationsFor(
        '[data-reading-mode="dyslexia"] .static-visual-output'
      )
    ).toMatchObject({
      "border-color": "var(--document-border)",
      background: "var(--document-paper)"
    });
    expect(
      stylesheet.indexOf(
        '[data-reading-mode="dyslexia"] .static-visual-output'
      )
    ).toBeGreaterThan(
      stylesheet.indexOf('[data-theme="midnight"] .static-visual-output')
    );
    expect(
      declarationsFor(
        '[data-reading-mode="dyslexia"] .static-visual-output .visual-status'
      )["color"]
    ).toBe("var(--document-muted)");
    expect(
      declarationsFor(
        '[data-reading-mode="dyslexia"] .static-visual-output .visual-error'
      )["color"]
    ).toBe("var(--document-error)");
  });

  it("keeps themed reading surfaces reachable at responsive breakpoints", () => {
    for (const width of [1050, 760, 560]) {
      expect(stylesheet).toContain(`@media (max-width: ${width}px)`);
    }
    expect(declarationsFor("\n.format-toolbar {")["overflow-x"]).toBe("auto");
    expect(declarationsFor("\n.chart-data-summary {")["overflow-x"]).toBe(
      "auto"
    );
    expect(declarationsFor("\n.image-dialog {")).toMatchObject({
      "max-width": "calc(100vw - 32px)",
      "max-height": "calc(100dvh - 32px)",
      overflow: "hidden"
    });
    expect(declarationsFor("\n.image-dialog-panel {")["grid-template-rows"]).toBe(
      "auto minmax(0, 1fr) auto"
    );
    expect(declarationsFor("\n.image-dialog-body {")["overflow-y"]).toBe(
      "auto"
    );
    expect(stylesheet).toContain(".app-shell.embedded .document-navigation");
    expect(stylesheet).toContain("overflow-wrap: anywhere");
  });
});

function declarationsFor(selector: string): Record<string, string> {
  const selectorAt = stylesheet.indexOf(selector);
  if (selectorAt < 0) throw new Error(`Missing CSS selector ${selector}`);
  const open = stylesheet.indexOf("{", selectorAt);
  const close = stylesheet.indexOf("}", open);
  const declarations: Record<string, string> = {};
  for (const match of stylesheet
    .slice(open + 1, close)
    .matchAll(/((?:--)?[a-z][a-z0-9-]*)\s*:\s*([^;]+);/g)) {
    declarations[match[1]!] = match[2]!.replace(/\s+/g, " ").trim();
  }
  return declarations;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16) / 255
  );
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
