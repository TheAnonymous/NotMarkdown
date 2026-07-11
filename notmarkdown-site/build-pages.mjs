import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(siteDirectory, "..");
const outputDirectory = resolve(repositoryRoot, "pages-dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(resolve(outputDirectory, "studio"), { recursive: true });
await mkdir(resolve(outputDirectory, "docs"), { recursive: true });
await mkdir(resolve(outputDirectory, "downloads"), { recursive: true });

const sourceHtml = await readFile(resolve(siteDirectory, "index.html"), "utf8");
const replacements = new Map([
  ["../notmarkdown-web-editor/dist/index.html", "studio/index.html"],
  ["../NotMarkdown-visuals-0.1.nmdoc", "downloads/NotMarkdown-visuals-0.1.nmdoc"],
  ["../NotMarkdown-v0.1-Draft.md", "docs/NotMarkdown-v0.1-Draft.md"],
  ["../NotMarkdown-Editor-Architecture-0.1.md", "docs/NotMarkdown-Editor-Architecture-0.1.md"],
  ["../notmarkdown-vscode/README.md", "https://github.com/TheAnonymous/NotMarkdown/tree/main/notmarkdown-vscode"],
  ["../notmarkdown-jetbrains/README.md", "https://github.com/TheAnonymous/NotMarkdown/tree/main/notmarkdown-jetbrains"]
]);
let html = sourceHtml;
for (const [from, to] of replacements) html = html.replaceAll(from, to);
if (/\.\.\//.test(html)) throw new Error("Published landing page still contains parent-directory links.");

await writeFile(resolve(outputDirectory, "index.html"), html);
await writeFile(resolve(outputDirectory, "404.html"), html);
await cp(resolve(siteDirectory, "styles.css"), resolve(outputDirectory, "styles.css"));
await cp(resolve(repositoryRoot, "notmarkdown-web-editor/dist"), resolve(outputDirectory, "studio"), { recursive: true });

for (const fileName of [
  "NotMarkdown-v0.1-Draft.md",
  "NotMarkdown-Editor-Architecture-0.1.md",
  "NotMarkdown-Adoption-Plan-0.1.md",
  "notmarkdown-cdm-0.1.schema.json",
  "notmarkdown-manifest-0.1.schema.json",
  "notmarkdown-source-0.1.ebnf",
  "LICENSE-POLICY.md",
  "THIRD_PARTY_NOTICES.md"
]) {
  await cp(resolve(repositoryRoot, fileName), resolve(outputDirectory, "docs", fileName));
}
await cp(
  resolve(repositoryRoot, "LICENSES"),
  resolve(outputDirectory, "docs/LICENSES"),
  { recursive: true }
);
await cp(
  resolve(repositoryRoot, "NotMarkdown-visuals-0.1.nmdoc"),
  resolve(outputDirectory, "downloads", "NotMarkdown-visuals-0.1.nmdoc")
);
await cp(resolve(repositoryRoot, "LICENSE"), resolve(outputDirectory, "LICENSE.txt"));
await writeFile(resolve(outputDirectory, ".nojekyll"), "");
await writeFile(
  resolve(outputDirectory, "robots.txt"),
  "User-agent: *\nAllow: /\n"
);

console.log(`GitHub Pages site built at ${outputDirectory}`);
