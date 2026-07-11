import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDirectory = dirname(fileURLToPath(import.meta.url));
const output = resolve(siteDirectory, "../pages-dist");
const html = await readFile(resolve(output, "index.html"), "utf8");
const studio = await readFile(resolve(output, "studio/index.html"), "utf8");
const fontCss = await readFile(
  resolve(output, "studio/accessibility-fonts.css"),
  "utf8"
);

for (const expected of [
  'src="studio/index.html?embed=1"',
  'href="studio/index.html"',
  'href="downloads/NotMarkdown-visuals-0.1.nmdoc"',
  'href="docs/NotMarkdown-v0.1-Draft.md"'
]) {
  if (!html.includes(expected)) throw new Error(`Missing published path: ${expected}`);
}
if (/\.\.\//.test(html)) throw new Error("Published HTML contains a parent-directory path.");
if (!studio.includes("Content-Security-Policy")) throw new Error("Studio CSP is missing from the published build.");
if (!studio.includes('href="./accessibility-fonts.css"')) {
  throw new Error("Published Studio does not load its accessibility fonts.");
}
for (const font of [
  "OpenDyslexic-Regular.woff2",
  "OpenDyslexic-Bold.woff2"
]) {
  if (!fontCss.includes(`./fonts/${font}`)) {
    throw new Error(`Published font stylesheet is missing ${font}.`);
  }
}

for (const path of [
  ".nojekyll",
  "404.html",
  "styles.css",
  "studio/manifest.webmanifest",
  "studio/sw.js",
  "studio/accessibility-fonts.css",
  "studio/fonts/OpenDyslexic-Regular.woff2",
  "studio/fonts/OpenDyslexic-Bold.woff2",
  "downloads/NotMarkdown-visuals-0.1.nmdoc",
  "docs/NotMarkdown-v0.1-Draft.md",
  "docs/notmarkdown-cdm-0.1.schema.json",
  "docs/LICENSES/OFL-1.1.txt",
  "LICENSE.txt"
]) await access(resolve(output, path));

console.log("GitHub Pages artifact paths and embedded Studio verified.");
