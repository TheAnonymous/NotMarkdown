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

const localLinks = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)]
  .map((match) => match[1])
  .filter((value) => !/^[a-z]+:/i.test(value))
  .map((value) => value.split(/[?#]/, 1)[0]);
for (const link of new Set(localLinks)) await access(resolve(directory, link));

console.log(
  `Landing page OK · live Studio embedded · ${html.length} HTML bytes · ${css.length} CSS bytes · ${localLinks.length} local links`
);
