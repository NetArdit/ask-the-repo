import type { LoadedIndex } from "../retrieve/loaded-index";
import type { Evidence } from "../retrieve/search";

/**
 * Benchmark version 3, change 2 (reports/route2-benchmark-v3-design.md): "which modules import X?" is a question the index can
 * answer as data. Search returns some importers and the model then lists them as if they were all of them, which no quoted line
 * can show. Here the import table is read instead: every importer's import line is offered as evidence, and the count is stated
 * by the application, not by the model.
 *
 * The index's import table has blind spots (dynamic imports, specifiers it could not resolve), so the wording everywhere is
 * "the index lists", never "all".
 */
export interface ImporterFact {
  kind: "importers";
  /** What is imported, as words for a person: a name ("HTTPError") or a file ("lib/only.js"). */
  target: string;
  /** One entry per importing file, source files first, each with the line of its first matching import. */
  files: { path: string; line: number; source: boolean }[];
}

export interface ImporterEvidenceOptions {
  /** Most importer blocks added to a prompt. They come after the retrieved blocks and share their character budget. */
  maxBlocks: number;
}

export type ImporterCandidate = Pick<Evidence, "chunkId" | "path" | "startLine" | "endLine" | "score">;

/** The thing asked about, from the ways such a question is usually put. Null when the question is not about who imports something. */
function importedPhrase(question: string): string | null {
  const q = question.trim().replace(/[?.!\s]+$/, "");
  const forms = [
    /\b(?:which|what)\s+(?:\w+\s+){0,2}?(?:modules?|files?|packages?|components?)\s+(?:import|imports|importing|require|requires)\s+(.+)$/i,
    /\bwho\s+(?:imports|requires)\s+(.+)$/i,
    /\bwhere\s+is\s+(.+?)\s+(?:imported|required)\b/i,
    /\b(?:list|show|find)\s+(?:all\s+)?(?:the\s+)?(?:modules?|files?)\s+(?:that\s+)?(?:import|imports|importing|require|requires)\s+(.+)$/i,
  ];
  for (const f of forms) {
    const m = f.exec(q);
    if (m) return m[1]!.trim();
  }
  return null;
}

const FILLER = new Set(["the", "a", "an", "module", "modules", "file", "files", "helper", "package", "function", "class", "component", "hook", "type"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function words(phrase: string): string[] {
  return phrase.split(/[^A-Za-z0-9_$]+/).filter((w) => w !== "" && !FILLER.has(w.toLowerCase()));
}

/** The one source file whose path carries every given word, preferring a file named for the last word. Null when not exactly one. */
function fileNamed(index: LoadedIndex, ws: string[]): number | null {
  if (ws.length === 0) return null;
  const terms = ws.flatMap((w) => index.symbolTermsFor(w));
  if (terms.length === 0) return null;
  let hits = index.artifact.files.map((_, i) => i).filter((i) => index.fileClass[i] === "source" && terms.every((t) => index.pathTermsOfFile[i]!.includes(t)));
  if (hits.length > 1) {
    const last = ws[ws.length - 1]!.toLowerCase();
    const named = hits.filter((i) => {
      const base = index.pathOf(i).split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
      return base === last || (base === "index" && index.pathOf(i).split("/").slice(-2, -1)[0]?.toLowerCase() === last);
    });
    if (named.length > 0) hits = named;
  }
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Who imports what the question asks about, from the import table. Null when the question is not of that kind, or when what it
 * names cannot be pinned to one imported name or one file: nothing is guessed.
 */
export function findImporters(index: LoadedIndex, question: string): ImporterFact | null {
  const phrase = importedPhrase(question);
  if (phrase === null) return null;
  const a = index.artifact;
  const imports = a.imports;

  let rows: typeof imports = [];
  let target = "";
  // "getCart from the shopify module": a name, and where it comes from.
  const from = /^(\S+)\s+from\s+(.+)$/i.exec(phrase);
  const single = words(phrase);
  const name = from ? from[1]! : single.length === 1 ? single[0]! : null;
  const asksForModule = !from && /\b(?:module|file|helper|package)s?$/i.test(phrase);

  if (asksForModule || (name === null && single.length > 0)) {
    const file = fileNamed(index, single);
    if (file !== null) {
      rows = imports.filter((r) => r[3] === file);
      target = index.pathOf(file);
    }
  }
  if (rows.length === 0 && name !== null && IDENTIFIER.test(name)) {
    rows = imports.filter((r) => r[5].includes(name));
    target = name;
    if (from && rows.length > 0) {
      // "X from the Y module" asks about one source of X. If no import of X comes from anything called Y, the question is not
      // answered by the importers of some other X: say nothing rather than the wider list.
      const hint = words(from[2]!).flatMap((w) => index.symbolTermsFor(w));
      rows = rows.filter((r) => hint.length > 0 && (r[3] >= 0 ? hint.every((t) => index.pathTermsOfFile[r[3]]!.includes(t)) : hint.every((t) => r[1].toLowerCase().includes(t))));
    }
  }
  if (rows.length === 0) return null;

  const first = new Map<number, number>();
  for (const r of rows) if (!first.has(r[0]) || r[4] < first.get(r[0])!) first.set(r[0], r[4]);
  const files = [...first]
    .map(([file, line]) => ({ path: index.pathOf(file), line, source: index.fileClass[file] === "source" }))
    .sort((x, y) => Number(y.source) - Number(x.source) || x.path.localeCompare(y.path));
  return { kind: "importers", target, files };
}

/**
 * The chunks holding the import lines of the source files that import the target, leaving out any already on show. At most
 * `maxBlocks`. Importers in tests, examples and docs are counted in the note but not shown: a library's tests import nearly
 * everything, and showing them would spend the budget on lines nobody asked about. If no source file imports the target, the
 * others are shown instead, so that the answer is never left without a single import line.
 */
export function importerCandidates(index: LoadedIndex, fact: ImporterFact, shown: { path: string; startLine: number; endLine: number }[], options: ImporterEvidenceOptions): ImporterCandidate[] {
  const fileIdx = new Map(index.artifact.files.map((f, i) => [f[0], i]));
  const out: ImporterCandidate[] = [];
  const taken = new Set<number>();
  const inSource = fact.files.filter((f) => f.source);
  for (const f of inSource.length > 0 ? inSource : fact.files) {
    if (out.length >= options.maxBlocks) break;
    if (shown.some((s) => s.path === f.path && s.startLine <= f.line && s.endLine >= f.line)) continue;
    const chunkId = index.chunkAtLine(fileIdx.get(f.path)!, f.line);
    if (chunkId === null || taken.has(chunkId)) continue;
    taken.add(chunkId);
    const chunk = index.artifact.chunks[chunkId]!;
    out.push({ chunkId, path: f.path, startLine: chunk[1], endLine: chunk[2], score: 0 });
  }
  return out;
}

/** The application's own statement of the fact for the prompt: the counts, and which evidence blocks show an import line. */
export function importerNote(fact: ImporterFact, evidence: { id: string; path: string; startLine: number; endLine: number }[]): string {
  const source = fact.files.filter((f) => f.source).length;
  const shown = fact.files.map((f) => evidence.find((e) => e.path === f.path && e.startLine <= f.line && e.endLine >= f.line)?.id).filter((id): id is string => id !== undefined);
  return `importers of ${fact.target}: the index lists ${fact.files.length} importing file(s), ${source} in source and ${fact.files.length - source} in tests, examples or docs. Import lines shown in evidence: ${shown.length ? shown.join(", ") : "none"}.`;
}
