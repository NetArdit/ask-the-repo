export type Language =
  | "javascript" | "typescript" | "tsx" | "markdown" | "config"
  | "html" | "css" | "json" | "yaml" | "python" | "java" | "go" | "rust" | "c" | "cpp" | "csharp" | "php" | "ruby"
  | "kotlin" | "swift" | "shell" | "sql" | "vue" | "svelte" | "other";

export type SkipReason =
  | "vendored"
  | "lockfile"
  | "minified-name"
  | "binary-extension"
  | "unsupported-extension"
  | "too-large"
  | "minified-content"
  | "generated"
  | "binary-content";

const VENDORED_DIRS = new Set([
  "node_modules", "vendor", "vendors", "third_party", "third-party", "dist", "build", "out", ".next", ".nuxt",
  "coverage", ".git", ".yarn", ".pnpm-store", "bower_components", "__pycache__", ".turbo", ".cache",
]);

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb", "bun.lock", "composer.lock", "Cargo.lock",
]);

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svgz", "pdf", "zip", "gz", "tgz", "tar", "7z", "rar", "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "wav", "ogg", "webm", "wasm", "so", "dll", "exe", "dylib", "class", "jar", "node", "bin", "psd", "ai",
]);

const LANGUAGE_BY_EXT: Record<string, Language> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  md: "markdown", mdx: "markdown",
};

/**
 * Languages the application reads in addition to JavaScript, TypeScript and Markdown when it is asked to read every text file
 * (IndexConfig.broadFiles). They are indexed as plain text in fixed windows: no syntax tree, no symbols and no import graph,
 * so retrieval for them is by words alone.
 */
const BROAD_LANGUAGE_BY_EXT: Record<string, Language> = {
  html: "html", htm: "html", xhtml: "html",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml",
  py: "python", pyw: "python", pyi: "python",
  java: "java",
  go: "go",
  rs: "rust",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby", rake: "ruby",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "shell", bat: "shell", cmd: "shell",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
};

/** Directories that hold dependencies, build output or tooling state in ecosystems other than npm. Skipped in broad mode only. */
const BROAD_VENDORED_DIRS = new Set([
  "target", "bin", "obj", ".venv", "venv", "env", "site-packages", ".gradle", ".idea", ".vscode", "pods", ".terraform", ".dart_tool",
  ".mypy_cache", ".pytest_cache", ".tox", ".eggs", "__generated__",
]);

/** Data and media that are text on disk but are not source: they would fill the index with numbers. Skipped in broad mode only. */
const BROAD_SKIP_EXT = new Set(["svg", "csv", "tsv", "ndjson", "jsonl", "ipynb", "parquet", "sqlite", "db", "lock", "pem", "key", "crt", "p12", "pb", "dat", "log"]);

/** Licence text answers nothing about the code. */
const BROAD_SKIP_NAMES = /^(licen[sc]e|copying|notice|authors|contributors|patents)(\..*)?$/i;

/** Largest file read in broad mode outside JavaScript, TypeScript and Markdown. */
export const BROAD_MAX_FILE_BYTES = 300_000;
/** Most files read in broad mode outside JavaScript, TypeScript and Markdown, so one repository cannot fill the index with them. */
export const BROAD_MAX_FILES = 3000;

export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

const CONFIG_FILES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "nx.json", "turbo.json", "vercel.json", "deno.json", "jsr.json", "lerna.json",
]);

/** Configuration files that carry deterministic project metadata (entry points, workspaces, path aliases). */
export function isConfigFile(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  return CONFIG_FILES.has(base) || /^tsconfig..+.json$/.test(base);
}

export function languageOf(filePath: string): Language {
  if (isConfigFile(filePath)) return "config";
  return LANGUAGE_BY_EXT[extensionOf(filePath)] ?? "other";
}

/** As languageOf, but names the other languages read in broad mode. Anything unrecognised is "other", still read as text. */
export function broadLanguageOf(filePath: string): Language {
  if (isConfigFile(filePath)) return "config";
  const ext = extensionOf(filePath);
  return LANGUAGE_BY_EXT[ext] ?? BROAD_LANGUAGE_BY_EXT[ext] ?? "other";
}

/** True for the languages the index understands structurally (symbols, imports); everything else is read as text. */
export function isStructuredLanguage(language: Language): boolean {
  return language === "javascript" || language === "typescript" || language === "tsx";
}

export interface PathOptions {
  includeConfig?: boolean;
  /** Read every text file, not only JavaScript, TypeScript and Markdown. */
  broad?: boolean;
}

/** Path-only decision, made before any file content is read. */
export function classifyPath(filePath: string, options: PathOptions = {}): SkipReason | null {
  const segments = filePath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => VENDORED_DIRS.has(s))) return "vendored";
  if (options.broad && segments.slice(0, -1).some((s) => BROAD_VENDORED_DIRS.has(s.toLowerCase()))) return "vendored";
  if (LOCKFILES.has(base)) return "lockfile";
  if (options.includeConfig && isConfigFile(filePath)) return null;
  if (/\.min\.[a-z]+$/i.test(base) || /\.(map|snap)$/i.test(base) || /\.bundle\.[a-z]+$/i.test(base)) return "minified-name";
  if (BINARY_EXT.has(extensionOf(filePath))) return "binary-extension";
  if (options.broad) {
    // Every other file is read as text; the content check drops anything that is not text.
    if (BROAD_SKIP_EXT.has(extensionOf(filePath)) || BROAD_SKIP_NAMES.test(base)) return "unsupported-extension";
    return null;
  }
  if (languageOf(filePath) === "other" || languageOf(filePath) === "config") return "unsupported-extension";
  return null;
}

/** Content-based decision for files that passed the path check. */
export function classifyContent(content: Buffer, language: Language): SkipReason | null {
  const probe = content.subarray(0, 8000);
  if (probe.includes(0)) return "binary-content";
  const head = probe.toString("utf8", 0, 600);
  if (/@generated|DO NOT EDIT|auto-?generated|This file (was|is) generated/i.test(head)) return "generated";
  if (language !== "markdown") {
    // Minified bundles have very few, very long lines. A hand-written file with one long data literal does not.
    const limit = Math.min(content.length, 200_000);
    let lines = 1;
    for (let i = 0; i < limit; i++) if (content[i] === 10) lines++;
    if (limit / lines > 200) return "minified-content";
  }
  return null;
}
