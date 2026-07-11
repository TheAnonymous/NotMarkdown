export const DOCUMENT_THEME_OPTIONS = [
  { value: "standard", label: "Standard" },
  { value: "paper", label: "Paper" },
  { value: "technical", label: "Technical" },
  { value: "minimal", label: "Minimal" },
  { value: "sepia", label: "Sepia" },
  { value: "midnight", label: "Midnight" },
  { value: "high-contrast", label: "High Contrast" }
] as const;
export const DOCUMENT_ACCENTS = [
  "violet",
  "blue",
  "green",
  "orange",
  "neutral"
] as const;

export type DocumentTheme = (typeof DOCUMENT_THEME_OPTIONS)[number]["value"];
export type DocumentAccent = (typeof DOCUMENT_ACCENTS)[number];

export const DOCUMENT_THEMES: readonly DocumentTheme[] =
  DOCUMENT_THEME_OPTIONS.map(({ value }) => value);

export const READING_MODE_STORAGE_KEY = "notmarkdown.studio.reading-mode";

export function normalizeDocumentTheme(value: unknown): DocumentTheme {
  return DOCUMENT_THEMES.includes(value as DocumentTheme)
    ? (value as DocumentTheme)
    : "standard";
}

export function normalizeDocumentAccent(value: unknown): DocumentAccent {
  return DOCUMENT_ACCENTS.includes(value as DocumentAccent)
    ? (value as DocumentAccent)
    : "violet";
}

export function loadReadingMode(): boolean {
  try {
    return window.localStorage.getItem(READING_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeReadingMode(enabled: boolean): void {
  try {
    window.localStorage.setItem(
      READING_MODE_STORAGE_KEY,
      enabled ? "true" : "false"
    );
  } catch {
    // The in-memory React state remains usable when storage is unavailable.
  }
}
