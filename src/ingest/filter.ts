export type Language = "javascript" | "typescript" | "tsx" | "markdown" | "config" | "other";

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

/** Path-only decision, made before any file content is read. */
export function classifyPath(filePath: string, options: { includeConfig?: boolean } = {}): SkipReason | null {
  const segments = filePath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => VENDORED_DIRS.has(s))) return "vendored";
  if (LOCKFILES.has(base)) return "lockfile";
  if (options.includeConfig && isConfigFile(filePath)) return null;
  if (/\.min\.[a-z]+$/i.test(base) || /\.(map|snap)$/i.test(base) || /\.bundle\.[a-z]+$/i.test(base)) return "minified-name";
  if (BINARY_EXT.has(extensionOf(filePath))) return "binary-extension";
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
