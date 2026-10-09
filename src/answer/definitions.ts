import { SYMBOL_KIND_CODES } from "../index/types";
import type { LoadedIndex } from "../retrieve/loaded-index";
import type { Evidence } from "../retrieve/search";
import type { EvidenceItem } from "./types";

/**
 * Benchmark version 3, change 1 (reports/route2-benchmark-v3-design.md): when the evidence shows a call to a function but not
 * the function, offer the chunk that holds its definition too. Search ranks chunks by the question's words, so the line that
 * calls something tends to be retrieved and the body it calls does not; a claim about that body then rests on a name.
 *
 * Nothing here decides what is true. It only names more chunks to verify and show, and it guesses nothing: a name is followed
 * only when the index resolves it to exactly one definition.
 */
export interface DefinitionEvidenceOptions {
  /** Most definition blocks added to a prompt. They come after the retrieved blocks and share their character budget. */
  maxBlocks: number;
}

export type DefinitionCandidate = Pick<Evidence, "chunkId" | "path" | "startLine" | "endLine" | "score"> & { symbol: string };

/** Words that are followed by "(" without being a call to something defined in the repository. */
const NOT_A_CALL = new Set(
  "if for while switch catch return typeof function await async new throw else do in of case delete void yield super import export default class constructor require".split(" "),
);
/** An identifier, optionally private (#name), directly followed by an opening parenthesis. */
const CALL = /(#?[A-Za-z_$][\w$]*)\s*\(/g;
/** How much of a definition's start decides which chunk represents it. */
const HEAD_LINES = 40;
const FOLLOWED_KINDS = new Set(["function", "method", "variable"]);

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
}

/**
 * The one symbol a called name refers to, seen from `fromFile`, or null when the index cannot say. Order of trust: a definition
 * in the same file; then one in a file this file imports; then a name defined exactly once in the whole repository.
 */
function resolve(index: LoadedIndex, name: string, fromFile: number): number | null {
  const a = index.artifact;
  const rows = [...new Set([...(index.symbolsByName.get(name.toLowerCase()) ?? []), ...(index.symbolsByName.get(name.replace(/^#/, "").toLowerCase()) ?? [])])].filter((i) => {
    const s = a.symbols[i]!;
    // symbolsByName is case-insensitive and also keyed by qualified name; a call is neither.
    // Tests, fixtures, examples and docs define many look-alike helpers; a definition worth showing lives in the source.
    return (s[1] === name || s[1] === name.replace(/^#/, "")) && FOLLOWED_KINDS.has(SYMBOL_KIND_CODES[s[3]]!) && s[5] > s[4] && index.fileClass[s[0]] === "source";
  });
  if (rows.length === 0) return null;
  const local = rows.filter((i) => a.symbols[i]![0] === fromFile);
  if (local.length === 1) return local[0]!;
  if (local.length > 1) return null;
  const imported = new Set(index.importsOfFile.get(fromFile) ?? []);
  const viaImport = rows.filter((i) => imported.has(a.symbols[i]![0]));
  if (viaImport.length === 1) return viaImport[0]!;
  if (viaImport.length > 1) return null;
  return rows.length === 1 ? rows[0]! : null;
}

/** Question words that say nothing about which function is meant, or that match half the names in any codebase. */
const WEAK_TERMS = new Set("the and for how does where what when which who why are was its from with that this into each all any can get set use run has have not".split(" "));

/** The sub-words of the question, in the form the index stores symbol sub-words in. */
function questionTerms(index: LoadedIndex, question: string): Set<string> {
  const out = new Set<string>();
  for (const word of question.split(/[^A-Za-z0-9_$#]+/)) {
    if (word === "") continue;
    for (const t of index.symbolTermsFor(word)) if (t.length >= 3 && !WEAK_TERMS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Chunks holding the definitions of functions that the given evidence calls and does not already show, limited to functions
 * whose name shares a word with the question. Without that limit almost every answer gains two blocks, most of them beside the
 * point (measured on the tuning cases: 35 blocks added over 19 of 21 answers, for one more needed definition). Ordered by how
 * many of the question's words the name shares, then by how often it is called, then by where the call appears. At most `maxBlocks`.
 */
export function definitionCandidates(
  index: LoadedIndex,
  items: Pick<EvidenceItem, "path" | "startLine" | "endLine" | "text">[],
  question: string,
  options: DefinitionEvidenceOptions,
): DefinitionCandidate[] {
  if (options.maxBlocks <= 0) return [];
  const asked = questionTerms(index, question);
  if (asked.size === 0) return [];
  const a = index.artifact;
  const fileIdx = new Map(a.files.map((f, i) => [f[0], i]));
  const shown = items.map((it) => ({ file: fileIdx.get(it.path) ?? -1, start: it.startLine, end: it.endLine }));
  const isShown = (file: number, start: number, end: number) => shown.some((s) => s.file === file && overlap(s.start, s.end, start, Math.min(end, start + HEAD_LINES - 1)) > 0);

  const wanted = new Map<number, { shared: number; calls: number; first: number }>();
  const sharedWith = (name: string) => index.symbolTermsFor(name).filter((t) => asked.has(t)).length;
  let order = 0;
  for (const it of items) {
    const from = fileIdx.get(it.path);
    if (from === undefined) continue;
    for (const m of it.text.matchAll(CALL)) {
      const name = m[1]!;
      order += 1;
      if (NOT_A_CALL.has(name)) continue;
      const shared = sharedWith(name);
      if (shared === 0) continue;
      const sym = resolve(index, name, from);
      if (sym === null) continue;
      const s = a.symbols[sym]!;
      if (isShown(s[0], s[4], s[5])) continue;
      const seen = wanted.get(sym);
      if (seen) seen.calls += 1;
      else wanted.set(sym, { shared, calls: 1, first: order });
    }
  }

  const out: DefinitionCandidate[] = [];
  const taken = new Set<number>();
  for (const [sym] of [...wanted].sort((x, y) => y[1].shared - x[1].shared || y[1].calls - x[1].calls || x[1].first - y[1].first)) {
    if (out.length >= options.maxBlocks) break;
    const s = a.symbols[sym]!;
    const headEnd = Math.min(s[5], s[4] + HEAD_LINES - 1);
    // The chunk that holds most of the definition's first lines: a signature on a chunk's last line is better shown by the next one.
    const file = a.files[s[0]]!;
    let best: number | null = null;
    let bestOverlap = 0;
    for (let c = file[5]; c < file[5] + file[6]; c++) {
      const chunk = a.chunks[c]!;
      const o = overlap(chunk[1], chunk[2], s[4], headEnd);
      if (o > bestOverlap) {
        best = c;
        bestOverlap = o;
      }
    }
    if (best === null || taken.has(best)) continue;
    const chunk = a.chunks[best]!;
    if (shown.some((x) => x.file === s[0] && overlap(x.start, x.end, chunk[1], chunk[2]) > 0)) continue;
    taken.add(best);
    out.push({ chunkId: best, path: file[0], startLine: chunk[1], endLine: chunk[2], score: 0, symbol: s[2] || s[1] });
  }
  return out;
}
