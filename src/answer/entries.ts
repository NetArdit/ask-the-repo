import { ENTRY_KIND_CODES } from "../index/types";
import type { LoadedIndex } from "../retrieve/loaded-index";
import type { Evidence } from "../retrieve/search";

/**
 * Benchmark version 3, change 3 (reports/route2-benchmark-v3-design.md): "what is the entry point of X?" has a declared answer,
 * the package manifest's main / exports fields, which the index already resolved to files when it was built. Search tends to
 * return the entry file and not the manifest line that makes it one, so the model calls a file "the entry point" on no stated
 * ground. Here the declared entries are read from the index, the declaring lines of the manifest are offered as evidence, and
 * the list is stated by the application.
 */
export interface EntryFact {
  kind: "entries";
  /** The package the question is about, as named in its manifest. */
  pkg: string;
  /** Declared entry points that resolve to an indexed file. */
  entries: { path: string; entryKind: string }[];
  /** The manifest that declares them, when it is an indexed file. */
  manifest: string | null;
}

export interface EntryEvidenceOptions {
  /** Most blocks added to a prompt: the manifest's declaring lines, then the main entry file's exports. */
  maxBlocks: number;
}

export type EntryCandidate = Pick<Evidence, "chunkId" | "path" | "startLine" | "endLine" | "score">;

const ASKS_FOR_ENTRY = /\bentry[\s-]?(?:points?|files?|modules?)\b|\bpackage\s+(?:exports?|entr(?:y|ies))\b|\bmain\s+(?:file|module|entry)\b|\bexports?\s+(?:field|map)\b/i;
const DECLARING_KEY = /^\s*"(?:main|module|exports|bin|browser|types)"\s*:/;
/** `main` first: it is what "the entry point" means when a package declares several. */
const KIND_ORDER = ["main", "module", "exports", "browser", "bin", "types"];

/**
 * The declared entry points of the package the question is about. Null when the question does not ask for an entry point, when
 * the index knows no declared entry, or when several packages declare entries and the question does not say which is meant.
 */
export function findEntries(index: LoadedIndex, question: string, repoName: string): EntryFact | null {
  if (!ASKS_FOR_ENTRY.test(question)) return null;
  const packages = [...new Set(index.entryFiles.map((e) => e.pkg))];
  if (packages.length === 0) return null;
  const mentions = (pkg: string) => {
    const bare = pkg.includes("/") ? pkg.split("/").pop()! : pkg;
    return new RegExp(`(?:^|[^\\w@/-])(?:${[pkg, bare].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "i").test(question);
  };
  let pkg: string | null = null;
  if (packages.length === 1) pkg = packages[0]!;
  else {
    const named = packages.filter(mentions);
    if (named.length === 1) pkg = named[0]!;
    else if (named.length === 0 && packages.includes(repoName)) pkg = repoName;
  }
  if (pkg === null) return null;

  const rows = index.entryFiles.filter((e) => e.pkg === pkg);
  // An exports map can name one file under several conditions; each (kind, file) pair is listed once.
  const seen = new Set<string>();
  const entries = rows
    .map((e) => ({ path: index.pathOf(e.file), entryKind: ENTRY_KIND_CODES[e.kind]! as string }))
    .filter((e) => !seen.has(`${e.entryKind} ${e.path}`) && seen.add(`${e.entryKind} ${e.path}`))
    .sort((a, b) => KIND_ORDER.indexOf(a.entryKind) - KIND_ORDER.indexOf(b.entryKind) || a.path.localeCompare(b.path));
  // The manifest is the nearest package.json at or above the entry files.
  const paths = new Set(index.artifact.files.map((f) => f[0]));
  let manifest: string | null = null;
  const dirs = entries[0]!.path.split("/").slice(0, -1);
  for (let depth = dirs.length; depth >= 0 && manifest === null; depth--) {
    const candidate = [...dirs.slice(0, depth), "package.json"].join("/");
    if (paths.has(candidate)) manifest = candidate;
  }
  return { kind: "entries", pkg, entries, manifest };
}

/**
 * The line of the manifest on which the first entry field (main, module, exports, ...) is declared, or null. The manifest has
 * to be read for this: the index keeps no source text. `readFile` returns a file's text at the indexed commit.
 */
export async function declaringLine(fact: EntryFact, readFile: (path: string) => Promise<string | null>): Promise<number | null> {
  if (fact.manifest === null) return null;
  const text = await readFile(fact.manifest);
  const line = text === null ? -1 : text.split(/\r?\n/).findIndex((l) => DECLARING_KEY.test(l));
  return line >= 0 ? line + 1 : null;
}

/**
 * The chunks to show for a declared entry point: the manifest lines that declare it (at `declLine`), then the main entry file's
 * first exports. Blocks already on show are left out. At most `maxBlocks`.
 */
export function entryCandidates(index: LoadedIndex, fact: EntryFact, declLine: number | null, shown: { path: string; startLine: number; endLine: number }[], options: EntryEvidenceOptions): EntryCandidate[] {
  const fileIdx = new Map(index.artifact.files.map((f, i) => [f[0], i]));
  const wanted: { path: string; line: number }[] = [];
  if (fact.manifest !== null && declLine !== null) wanted.push({ path: fact.manifest, line: declLine });
  const main = fact.entries[0]!;
  const mainIdx = fileIdx.get(main.path);
  if (mainIdx !== undefined) {
    const exportLines = index.artifact.exports.filter((e) => e[0] === mainIdx).map((e) => e[2]);
    wanted.push({ path: main.path, line: exportLines.length > 0 ? Math.min(...exportLines) : 1 });
  }
  const out: EntryCandidate[] = [];
  const taken = new Set<number>();
  for (const w of wanted) {
    if (out.length >= options.maxBlocks) break;
    if (shown.some((s) => s.path === w.path && s.startLine <= w.line && s.endLine >= w.line)) continue;
    const idx = fileIdx.get(w.path);
    const chunkId = idx === undefined ? null : index.chunkAtLine(idx, w.line);
    if (chunkId === null || taken.has(chunkId)) continue;
    taken.add(chunkId);
    const chunk = index.artifact.chunks[chunkId]!;
    out.push({ chunkId, path: w.path, startLine: chunk[1], endLine: chunk[2], score: 0 });
  }
  return out;
}

/** The application's own statement of the fact for the prompt: the declared entries, and where the declaring lines are shown. */
export function entryNote(fact: EntryFact, declLine: number | null, evidence: { id: string; path: string; startLine: number; endLine: number }[]): string {
  const MAX_LISTED = 6;
  const listed = fact.entries.slice(0, MAX_LISTED).map((e) => `${e.entryKind} -> ${e.path}`);
  const more = fact.entries.length > MAX_LISTED ? ` (+${fact.entries.length - MAX_LISTED} more)` : "";
  const manifestId = declLine === null ? undefined : evidence.find((e) => e.path === fact.manifest && e.startLine <= declLine && e.endLine >= declLine)?.id;
  // A package may declare no entry field at all, in which case its entry is the default the runtime assumes, not a stated line.
  const where =
    fact.manifest === null
      ? "The declaring manifest is not an indexed file."
      : declLine === null
        ? `The manifest is ${fact.manifest}; no line declaring an entry field was found in it, so this entry is not stated there in so many words.`
        : `Declared in ${fact.manifest}${manifestId ? `; the declaring lines are shown in evidence as ${manifestId}` : "; its declaring lines are not among the evidence"}.`;
  return `entry points of package ${fact.pkg}, as the index resolved them: ${listed.join("; ")}${more}. ${where}`;
}
