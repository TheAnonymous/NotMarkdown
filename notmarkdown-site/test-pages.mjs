import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDirectory = dirname(fileURLToPath(import.meta.url));
const output = resolve(siteDirectory, "../pages-dist");
const html = await readFile(resolve(output, "index.html"), "utf8");
const studio = await readFile(resolve(output, "studio/index.html"), "utf8");

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

for (const path of [
  ".nojekyll",
  "404.html",
  "styles.css",
  "studio/manifest.webmanifest",
  "studio/sw.js",
  "downloads/NotMarkdown-visuals-0.1.nmdoc",
  "docs/NotMarkdown-v0.1-Draft.md",
  "docs/notmarkdown-cdm-0.1.schema.json",
  "LICENSE.txt"
]) await access(resolve(output, path));

console.log("GitHub Pages artifact paths and embedded Studio verified.");
