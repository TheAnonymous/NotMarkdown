import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const html = await readFile(resolve(directory, "index.html"), "utf8");
const css = await readFile(resolve(directory, "styles.css"), "utf8");
const studioHtml = await readFile(
  resolve(directory, "../notmarkdown-web-editor/dist/index.html"),
  "utf8"
);
const studioFontCss = await readFile(
  resolve(directory, "../notmarkdown-web-editor/dist/accessibility-fonts.css"),
  "utf8"
);

for (const id of ["studio", "format", "visuals", "tooling", "plugins", "trust"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing section ${id}`);
}
if (!html.includes("Studio 0.7")) {
  throw new Error("Landing page and embedded Studio version have drifted.");
}
for (const visual of ["Mermaid", "Vega-Lite", "draw.io", "NotMarkdown-visuals-0.1.nmdoc"]) {
  if (!html.includes(visual)) throw new Error(`Missing static visual story: ${visual}`);
}
for (const command of ["notmarkdown import", "notmarkdown git install", "notmarkdown verify"]) {
  if (!html.includes(command)) throw new Error(`Missing adoption command: ${command}`);
}
if (/<script\b/i.test(html)) throw new Error("Landing page must remain script-free.");
if (!/<iframe\b[^>]*title="Live NotMarkdown Studio editor"/i.test(html)) {
  throw new Error("Missing directly embedded live Studio editor.");
}
if (!html.includes("index.html?embed=1")) {
  throw new Error("Studio iframe must use compact embed mode.");
}
for (const message of [
  "Themes and accents travel with the document",
  "seven document-bound theme presets",
  "Standard, Paper, Technical, Minimal",
  "Sepia, Midnight, and High Contrast",
  "Dyslexia-friendly reading mode",
  "changes only the Document view—not its source or package"
]) {
  if (!html.includes(message)) throw new Error(`Missing appearance story: ${message}`);
}
if (!html.includes('class="skip-link"')) {
  throw new Error("Missing keyboard skip navigation.");
}
if (!css.includes("@media (max-width: 620px)")) {
  throw new Error("Missing compact responsive layout.");
}
if (!css.includes("prefers-reduced-motion: reduce")) {
  throw new Error("Missing reduced-motion adaptation.");
}
if (/(?:src|href)="\/(?:assets|manifest|sw)/i.test(studioHtml)) {
  throw new Error("Studio production assets must remain portable below a subpath.");
}
if (!studioHtml.includes('href="./accessibility-fonts.css"')) {
  throw new Error("Studio must load the local accessibility font stylesheet.");
}
for (const font of [
  "OpenDyslexic-Regular.woff2",
  "OpenDyslexic-Bold.woff2"
]) {
  if (!studioFontCss.includes(`./fonts/${font}`)) {
    throw new Error(`Accessibility stylesheet is missing ${font}.`);
  }
  await access(resolve(directory, "../notmarkdown-web-editor/dist/fonts", font));
}
await access(resolve(directory, "../LICENSES/OFL-1.1.txt"));

const localLinks = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)]
  .map((match) => match[1])
  .filter((value) => !/^[a-z]+:/i.test(value))
  .map((value) => value.split(/[?#]/, 1)[0]);
for (const link of new Set(localLinks)) await access(resolve(directory, link));

console.log(
  `Landing page OK · live Studio embedded · ${html.length} HTML bytes · ${css.length} CSS bytes · ${localLinks.length} local links`
);
