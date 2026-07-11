export type NotMarkdownFileKind = "package" | "source";

export interface LaunchFileHandle {
  getFile(): Promise<File>;
}

export interface LaunchParams {
  files: readonly LaunchFileHandle[];
}

export interface BrowserLaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}

export const SHARED_FILE_ENDPOINT = "__notmarkdown_share_target__";

export function classifyNotMarkdownFile(
  file: Pick<File, "name">
): NotMarkdownFileKind | undefined {
  const name = file.name.toLowerCase();
  if (name.endsWith(".nmdoc")) return "package";
  if (name.endsWith(".nmt")) return "source";
  return undefined;
}

export function requireNotMarkdownFile(
  file: Pick<File, "name">
): NotMarkdownFileKind {
  const kind = classifyNotMarkdownFile(file);
  if (!kind) {
    throw new Error(
      "Unsupported file. Open a .nmt source or .nmdoc package instead."
    );
  }
  return kind;
}

export function browserLaunchQueue(
  target: Window = window
): BrowserLaunchQueue | undefined {
  return (
    target as typeof target & { launchQueue?: BrowserLaunchQueue }
  ).launchQueue;
}

export function sharedFileUrl(
  baseUrl: string = import.meta.env.BASE_URL,
  pageUrl: string = window.location.href
): string {
  const base = new URL(baseUrl, pageUrl);
  return new URL(SHARED_FILE_ENDPOINT, base).href;
}

export async function takePendingSharedFile(
  request: typeof fetch = fetch
): Promise<File> {
  const response = await request(sharedFileUrl(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error("No shared NotMarkdown file is waiting.");
  }

  const blob = await response.blob();
  const encodedName = response.headers.get("x-notmarkdown-filename");
  const name = safeSharedFileName(encodedName, blob.type);
  const file = new File([blob], name, { type: blob.type });
  requireNotMarkdownFile(file);
  return file;
}

function safeSharedFileName(
  encodedName: string | null,
  mediaType: string
): string {
  if (encodedName) {
    try {
      const decoded = decodeURIComponent(encodedName);
      const basename = decoded.replace(/\\/g, "/").split("/").pop()?.trim();
      if (basename && classifyNotMarkdownFile({ name: basename })) {
        return basename;
      }
    } catch {
      // Fall through to a type-derived, extension-safe name.
    }
  }

  return mediaType === "application/vnd.notmarkdown.document+zip"
    ? "shared.nmdoc"
    : "shared.nmt";
}
