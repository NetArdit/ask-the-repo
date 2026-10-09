import { pathTerms } from "../index/tokenize";
import { questionWantsNonSource, type FileClass } from "./file-class";
import type { LoadedIndex } from "./loaded-index";
import { analyzeQuestion } from "./query";

const K1 = 1.2;
const B = 0.75;
const SYMBOL_WEIGHT = 0.6;
const PATH_WEIGHT = 0.5;
const IMPORT_DECAY = 0.25;
const IMPORT_SEED_CHUNKS = 3;
const MAX_NEIGHBOURS = 20;
const MAX_PATH_FILES = 10;
const MAX_PER_FILE = 3;

export interface SearchOptions {
  k?: number;
  importExpansion?: boolean;
  /** Ablation switches for the benchmark; all default to on. */
  useSymbols?: boolean;
  usePaths?: boolean;
  /** Multipliers on the fused score of chunks in tests/examples/docs/config. Omitted means no demotion (Phase 1 behaviour). */
  classWeights?: Partial<Record<FileClass, number>>;
  /** Boost declared package entry points when the question is about startup or entry points. */
  entryBoost?: boolean;
  /** Weight of the entry-point signal in the fused score (default 0.6). */
  entryWeight?: number;
}

const DEFAULT_ENTRY_WEIGHT = 0.6;
const ENTRY_BASE = 0.35;
/** Words that announce the intent. When the entry boost is on they are not searched for lexically: they say "entry point", not what it is the entry point of. */
const ENTRY_TERMS = new Set(["entry", "point", "entrypoint", "main", "bootstrap", "startup", "start", "cli", "command", "line", "bin", "startup"]);
const ENTRY_INTENT = /\b(entry[- ]?points?|main (file|module)|bin|cli|command[- ]line|start ?up|bootstrap)\b/i;

export interface Evidence {
  /** Index of the chunk in the artifact; lets callers look up its content fingerprint. */
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  signals: { bm25: number; symbol: number; path: number; via: "import" | null };
  matchedSymbols: string[];
}

/** Query/evidence statistics a deterministic abstention rule can use. Computed for every search. */
export interface AbstentionFeatures {
  topScore: number;
  /** top1 - top2 fused score */
  margin: number;
  /** idf-weighted share of query terms present in the top-3 chunks */
  idfCoverage: number;
  /** idf-weighted share of query terms present in the top-1 chunk */
  top1Coverage: number;
  /** An exact symbol-name match is among the top-3 chunks */
  exactSymbolInTop3: boolean;
  /** The top-1 chunk's file path matched a query term */
  pathHitTop1: boolean;
  queryTermCount: number;
  identifierCount: number;
}

export interface SearchResult {
  evidence: Evidence[];
  features: AbstentionFeatures;
  queryTerms: string[];
  /** idf-weighted share of query terms that occur in the top-3 evidence chunks. Used for the negative-case experiment. */
  idfCoverage: number;
  unmatchedTerms: string[];
  latencyMs: number;
}

interface Candidate {
  bm25: number;
  symbol: number;
  path: number;
  via: "import" | null;
  entry: number;
  matchedSymbols: Set<string>;
  matchedTerms: Set<string>;
}

const idf = (n: number, df: number): number => Math.log(1 + (n - df + 0.5) / (df + 0.5));

export function search(index: LoadedIndex, question: string, options: SearchOptions = {}): SearchResult {
  const started = performance.now();
  const k = options.k ?? 10;
  const analyzed = analyzeQuestion(question, index.stemMode);
  const entryIntent = options.entryBoost === true && ENTRY_INTENT.test(question);
  const query = entryIntent
    ? { terms: analyzed.terms.filter((t) => !ENTRY_TERMS.has(t)), identifiers: analyzed.identifiers.filter((t) => !ENTRY_TERMS.has(t)) }
    : analyzed;
  const art = index.artifact;
  const candidates = new Map<number, Candidate>();
  const candidate = (id: number): Candidate => {
    let c = candidates.get(id);
    if (!c) candidates.set(id, (c = { bm25: 0, symbol: 0, path: 0, entry: 0, via: null, matchedSymbols: new Set(), matchedTerms: new Set() }));
    return c;
  };
  const termIdf = new Map<string, number>(query.terms.map((t) => [t, idf(index.chunkCount, index.documentFrequency(t))]));

  // 1. Lexical: BM25 over chunk term frequencies.
  for (const term of query.terms) {
    const postings = index.postings(term);
    if (!postings) continue;
    const w = termIdf.get(term)!;
    for (let i = 0; i < postings.chunkIds.length; i++) {
      const id = postings.chunkIds[i]!;
      const len = art.chunks[id]![3];
      const tf = postings.tfs[i]!;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * len) / (art.avgChunkLength || 1)));
      const c = candidate(id);
      c.bm25 += w * norm;
      c.matchedTerms.add(term);
    }
  }
  let maxBm25 = 0;
  for (const c of candidates.values()) maxBm25 = Math.max(maxBm25, c.bm25);

  // 2. Symbol names: exact (qualified) name hits plus idf-weighted sub-word coverage.
  const symbolScores = new Map<number, number>();
  const useSymbols = options.useSymbols ?? true;
  for (const id of useSymbols ? query.identifiers : []) {
    for (const s of index.symbolsByName.get(id) ?? []) symbolScores.set(s, Math.max(symbolScores.get(s) ?? 0, 1.5));
  }
  const touched = new Set<number>();
  for (const term of useSymbols ? query.terms : []) for (const s of index.symbolsByTerm.get(term) ?? []) touched.add(s);
  const queryTermSet = new Set(query.terms);
  for (const s of touched) {
    const symTerms = index.termsOfSymbol[s]!;
    let hit = 0;
    let total = 0;
    for (const t of symTerms) {
      const w = termIdf.get(t) ?? idf(index.chunkCount, index.documentFrequency(t));
      total += w;
      if (queryTermSet.has(t)) hit += w;
    }
    const score = total === 0 ? 0 : hit / total;
    if (score >= 0.5) symbolScores.set(s, Math.max(symbolScores.get(s) ?? 0, score));
  }
  for (const [s, score] of symbolScores) {
    const sym = art.symbols[s]!;
    const chunkId = index.chunkAtLine(sym[0], sym[4]);
    if (chunkId === null) continue;
    const c = candidate(chunkId);
    if (score > c.symbol) c.symbol = score;
    c.matchedSymbols.add(sym[2] || sym[1]);
  }

  // 3. Paths: idf-weighted coverage of the query by each file's path terms.
  const pathWeights = new Map<string, number>();
  for (const term of options.usePaths ?? true ? query.terms : []) {
    const files = index.filesByPathTerm.get(term);
    if (files) pathWeights.set(term, idf(index.fileCount, files.length));
  }
  const totalPathWeight = [...pathWeights.values()].reduce((a, b) => a + b, 0);
  const pathScores = new Map<number, number>();
  if (totalPathWeight > 0) {
    for (const term of pathWeights.keys()) {
      for (const f of index.filesByPathTerm.get(term) ?? []) {
        pathScores.set(f, (pathScores.get(f) ?? 0) + pathWeights.get(term)! / totalPathWeight);
      }
    }
  }
  const pathFiles = [...pathScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PATH_FILES);
  for (const [f, score] of pathFiles) {
    const file = art.files[f]!;
    const chunkIds = Array.from({ length: file[6] }, (_, i) => file[5] + i);
    const ranked = chunkIds.sort((a, b) => (candidates.get(b)?.bm25 ?? 0) - (candidates.get(a)?.bm25 ?? 0));
    for (const id of ranked.slice(0, MAX_PER_FILE)) candidate(id).path = Math.max(candidate(id).path, score);
  }

  // 3b. Declared package entry points, for startup/entry-point questions only.
  if (entryIntent) {
    const queryTermSet2 = new Set(query.terms);
    for (const e of index.entryFiles) {
      const file = art.files[e.file]!;
      const labelTerms = new Set([...pathTerms(e.pkg, index.stemMode), ...index.pathTermsOfFile[e.file]!]);
      const overlap = [...labelTerms].filter((t) => queryTermSet2.has(t)).length / Math.max(1, query.terms.length);
      const c = candidate(file[5]);
      c.entry = Math.max(c.entry, ENTRY_BASE + 0.5 * Math.min(1, overlap));
    }
  }

  // 4. Fuse, rank.
  const demote = options.classWeights && !questionWantsNonSource(question) ? options.classWeights : null;
  const classWeight = (id: number): number => (demote ? (demote[index.fileClass[art.chunks[id]![0]]!] ?? 1) : 1);
  const fused = (id: number, c: Candidate): number =>
    ((maxBm25 > 0 ? c.bm25 / maxBm25 : 0) + SYMBOL_WEIGHT * Math.min(c.symbol, 1.5) + PATH_WEIGHT * c.path + (options.entryWeight ?? DEFAULT_ENTRY_WEIGHT) * c.entry) * classWeight(id);
  let ranked = [...candidates.entries()].map(([id, c]) => ({ id, c, score: fused(id, c) }));
  ranked.sort((a, b) => b.score - a.score);

  // 5. One-hop import expansion, seeded by the strongest chunks.
  if (options.importExpansion ?? true) {
    const seeds = ranked.slice(0, IMPORT_SEED_CHUNKS);
    const seedFiles = new Set(seeds.map((s) => art.chunks[s.id]![0]));
    const neighbours = new Map<number, number>();
    for (const seed of seeds) {
      const file = art.chunks[seed.id]![0];
      const related = [...(index.importsOfFile.get(file) ?? []), ...(index.importersOfFile.get(file) ?? [])];
      for (const n of related) {
        if (!seedFiles.has(n) && neighbours.size < MAX_NEIGHBOURS) neighbours.set(n, Math.max(neighbours.get(n) ?? 0, seed.score));
      }
    }
    for (const [fileIdx, parentScore] of neighbours) {
      const file = art.files[fileIdx]!;
      let best = -1;
      let bestScore = 0;
      for (let id = file[5]; id < file[5] + file[6]; id++) {
        const s = candidates.get(id)?.bm25 ?? 0;
        if (s > bestScore) [best, bestScore] = [id, s];
      }
      if (best < 0) continue; // a neighbour with no lexical overlap is noise, not evidence
      const c = candidate(best);
      if (c.via === null && ranked.every((r) => r.id !== best)) c.via = "import";
      const bonus = IMPORT_DECAY * parentScore;
      ranked.push({ id: best, c, score: fused(best, c) + bonus });
    }
    const best = new Map<number, (typeof ranked)[number]>();
    for (const r of ranked) if (r.score > (best.get(r.id)?.score ?? -1)) best.set(r.id, r);
    ranked = [...best.values()].sort((a, b) => b.score - a.score);
  }

  // 6. Cap per file so one large file cannot crowd out everything else.
  const perFile = new Map<number, number>();
  const top = ranked.filter((r) => {
    const f = art.chunks[r.id]![0];
    const n = perFile.get(f) ?? 0;
    perFile.set(f, n + 1);
    return n < MAX_PER_FILE;
  }).slice(0, k);

  const evidence: Evidence[] = top.map(({ id, c, score }) => {
    const chunk = art.chunks[id]!;
    return {
      chunkId: id,
      path: index.pathOf(chunk[0]),
      startLine: chunk[1],
      endLine: chunk[2],
      score,
      signals: { bm25: maxBm25 > 0 ? c.bm25 / maxBm25 : 0, symbol: c.symbol, path: c.path, via: c.via },
      matchedSymbols: [...c.matchedSymbols].slice(0, 5),
    };
  });

  const covered = new Set<string>();
  for (const { id } of top.slice(0, 3)) for (const t of candidates.get(id)?.matchedTerms ?? []) covered.add(t);
  let totalIdf = 0;
  let coveredIdf = 0;
  for (const [term, w] of termIdf) {
    totalIdf += w;
    if (covered.has(term)) coveredIdf += w;
  }
  const top1Terms = top[0] ? (candidates.get(top[0].id)?.matchedTerms ?? new Set<string>()) : new Set<string>();
  let top1Idf = 0;
  for (const [term, w] of termIdf) if (top1Terms.has(term)) top1Idf += w;
  const features: AbstentionFeatures = {
    topScore: top[0]?.score ?? 0,
    margin: (top[0]?.score ?? 0) - (top[1]?.score ?? 0),
    idfCoverage: totalIdf === 0 ? 0 : coveredIdf / totalIdf,
    top1Coverage: totalIdf === 0 ? 0 : top1Idf / totalIdf,
    exactSymbolInTop3: top.slice(0, 3).some((t) => (candidates.get(t.id)?.symbol ?? 0) >= 1.5),
    pathHitTop1: top[0] ? (candidates.get(top[0].id)?.path ?? 0) > 0 : false,
    queryTermCount: query.terms.length,
    identifierCount: query.identifiers.length,
  };
  return {
    evidence,
    features,
    queryTerms: query.terms,
    idfCoverage: totalIdf === 0 ? 0 : coveredIdf / totalIdf,
    unmatchedTerms: query.terms.filter((t) => !covered.has(t)),
    latencyMs: performance.now() - started,
  };
}
