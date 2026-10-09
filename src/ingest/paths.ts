import path from "node:path/posix";

export type PathRejection = "empty" | "absolute" | "traversal" | "null-byte" | "backslash" | "too-long";

const MAX_PATH_LENGTH = 400;

/**
 * Normalizes an archive-supplied path into a safe, repo-relative POSIX path.
 * Paths are used only as identifiers; nothing is ever written to disk by them.
 */
export function normalizeArchivePath(raw: string): { ok: true; path: string } | { ok: false; reason: PathRejection } {
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, reason: "too-long" };
  if (raw.includes("\0")) return { ok: false, reason: "null-byte" };
  if (raw.includes("\\")) return { ok: false, reason: "backslash" };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return { ok: false, reason: "absolute" };
  if (raw.split("/").some((seg) => seg === "..")) return { ok: false, reason: "traversal" };
  const normalized = path.normalize(raw).replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("../")) return { ok: false, reason: "traversal" };
  return { ok: true, path: normalized };
}

/** GitHub tarballs prefix every entry with a single `<repo>-<sha>/` directory. */
export function stripArchiveRoot(raw: string): string | null {
  const i = raw.indexOf("/");
  return i === -1 ? null : raw.slice(i + 1);
}
