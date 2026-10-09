import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion, type AnswerResult } from "../answer/answer";
import { ExtractiveBaselineProvider, ProviderError, type ModelProvider, type RateLimitObservation } from "../answer/provider";
import type { PolicyConfig } from "../answer/policy";
import type { ClaimVerdict, Rejection } from "../answer/types";
import { V3_EVIDENCE } from "../answer/defaults";
import { EVIDENCE_CONTRACT } from "../answer/validate";
import { parsePromptVariant, type PromptVariant } from "../answer/prompt";
import { MapSource } from "../answer/source";
import { deserializeIndex } from "../index/serialize";
import { LocalFsStore } from "../index/store";
import { DEFAULT_LIMITS, ingestTarGz } from "../ingest/tarball";
import { parseRepoRef } from "../github/repo-ref";
import { LoadedIndex } from "../retrieve/loaded-index";
import { DEFAULT_SEARCH_OPTIONS } from "../retrieve/defaults";
import { CACHE_ROOT, ensureTarball, openCachedTarball } from "./cache";
import { assertFrozen, loadAnswerSpecs, loadQuestions, loadRepos, type BenchQuestion, type Split } from "./dataset";
import { median, overlaps } from "./evaluate";
import { indexConfigKey } from "./experiment";
import { resolveSpec } from "./experiments";

export const ANSWER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../reports/phase3");

export interface PolicyVariant {
  name: string;
  policy: PolicyConfig;
  /** Whether the stand-in model declines when told coverage is low. Real model behaviour is unmeasured; the two settings bound it. */
  captionDeclines: boolean;
}

/** (insufficientBelow, cautionBelow) pairs fixed before any answer run. */
export const POLICY_GRID: [number, number][] = [
  [0, 0],
  [0.5, 0.5],
  [0.1, 0.5],
  [0.2, 0.5],
  [0.25, 0.6],
  [0.3, 0.5],
  [0.35, 0.6],
];

export interface AnswerRecord {
  id: string;
  repo: string;
  category: string;
  negative: boolean;
  status: AnswerResult["status"];
  policyAction: AnswerResult["policy"]["action"];
  /** Structural results only: whether each id is real and whether its quote is in that block. The quotes themselves are source text and stay in the private record. */
  claims: { citations: { id: string; valid: boolean; reason?: string; quoteVerbatim: boolean }[]; status: string; text: string }[];
  /** Why the reply was not accepted, as sentences and as codes. Empty for an accepted answer. */
  reasons: string[];
  rejections: Rejection[];
  /** Distinct evidence items actually cited by at least one claim */
  cited: { path: string; startLine: number; endLine: number }[];
  offered: { id: string; path: string; startLine: number; endLine: number }[];
  rejectedEvidence: number;
  citesExpected: boolean;
  mentionsMet: boolean;
  features: AnswerResult["features"];
  stats: AnswerResult["stats"];
  /** Version 3 evidence only: what the application itself stated from the index (file names and lines, no source text). Not claims. */
  indexFacts?: AnswerResult["indexFacts"];
}

async function loadSource(repoName: string, sha: string): Promise<MapSource> {
  const files = new Map<string, string>();
  const tarball = await ensureTarball(parseRepoRef(repoName), sha);
  await ingestTarGz(openCachedTarball(tarball), DEFAULT_LIMITS, (f) => void files.set(f.path, f.content.toString("utf8")), { includeConfig: true });
  return new MapSource(files);
}

async function loadIndexFor(repoName: string, sha: string): Promise<LoadedIndex> {
  const spec = resolveSpec("accepted");
  const store = new LocalFsStore(path.join(CACHE_ROOT, "index", indexConfigKey(spec.index)));
  const bytes = await store.get({ ...parseRepoRef(repoName), sha });
  if (!bytes) throw new Error(`index missing for ${repoName}; run exp-cli run accepted first`);
  return new LoadedIndex(deserializeIndex(bytes).artifact);
}

/** The public record of one case. Exported so that a deterministic re-validation of stored replies builds records the same way. */
export function record(q: BenchQuestion, mentions: string[], r: Pick<AnswerResult, "claims" | "evidence" | "status" | "policy" | "reasons" | "rejections" | "rejectedEvidence" | "features" | "stats" | "indexFacts">): AnswerRecord {
  const citedIds = new Set(r.claims.flatMap((c) => c.citations.filter((x) => x.verdict.valid).map((x) => x.id)));
  const cited = r.evidence.filter((e) => citedIds.has(e.id)).map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine }));
  const claimText = r.claims.map((c) => c.text).join(" ").toLowerCase();
  return {
    id: q.id,
    repo: q.repo,
    category: q.category,
    negative: q.expected.length === 0,
    status: r.status,
    policyAction: r.policy.action,
    claims: r.claims.map((c) => ({
      text: c.text,
      status: c.status,
      citations: c.citations.map((x) => ({ id: x.id, valid: x.verdict.valid, ...(x.verdict.valid ? {} : { reason: x.verdict.reason }), quoteVerbatim: x.quoteVerbatim })),
    })),
    reasons: r.reasons,
    rejections: r.rejections,
    cited,
    offered: r.evidence.map((e) => ({ id: e.id, path: e.path, startLine: e.startLine, endLine: e.endLine })),
    rejectedEvidence: r.rejectedEvidence.length,
    citesExpected: cited.some((c) => q.expected.some((x) => overlaps({ ...c }, x))),
    mentionsMet: mentions.every((m) => claimText.includes(m.toLowerCase())),
    features: r.features,
    stats: r.stats,
    ...(r.indexFacts ? { indexFacts: r.indexFacts } : {}),
  };
}

/**
 * Everything needed to debug or re-score one case, including the model's reply exactly as it came and the quotes it gave.
 * Both can contain third-party source text, so these records are written under reports/private/, which git ignores, and are
 * never returned by the application. They contain no credentials: only what the model sent back and what the validator made of it.
 */
export interface PrivateRecord {
  id: string;
  repo: string;
  sha: string;
  question: string;
  split: Split;
  variant: string;
  promptVariant: PromptVariant;
  evidenceContract: number;
  provider: string;
  model: string | null;
  status: AnswerResult["status"];
  reasons: string[];
  rejections: Rejection[];
  claims: ClaimVerdict[];
  offered: { id: string; path: string; startLine: number; endLine: number; injectionSuspect: boolean }[];
  /** The model's reply before parsing; null when the model was not called or did not reply. */
  raw: string | null;
  stats: AnswerResult["stats"];
  recordedAt: string;
  /** Present (3) only on runs made with version 3 evidence. */
  evidenceVersion?: 3;
  /** Version 3 only: what the application itself stated from the index for this question. Not claims; never scored as claims. */
  indexFacts?: AnswerResult["indexFacts"];
}

export interface AnswerRun {
  /** The evidence contract the validator enforced. Runs under different contracts are not comparable. */
  evidenceContract: number;
  /** Model id, when the provider has one. */
  model?: string;
  provider: string;
  variant: string;
  split: Split;
  createdAt: string;
  records: AnswerRecord[];
  /** Instruction variant used, when one was selected explicitly; absent on runs made before selection existed (those are A). */
  promptVariant?: PromptVariant;
  /** Present (3) only on runs made with version 3 evidence; such a run is not comparable with version 2 runs case for case. */
  evidenceVersion?: 3;
  /** Checkpointed runs only: cases the provider could not answer. Not model-quality outcomes, so never part of `records`. */
  providerFailures?: { id: string; kind: string; status?: number; rateLimit?: RateLimitObservation }[];
  /** Checkpointed runs only: set when a rate/quota limit stopped the run. `records` is then partial and must not be scored as a whole run. */
  halted?: { nextId: string; reason: string };
  /** Checkpointed runs only: total cases in the split, and how many records came from the checkpoint rather than a new call. */
  total?: number;
  resumed?: number;
}

export interface RunOptions {
  /** JSONL file of completed records. Existing lines are reused instead of calling the model again. */
  checkpointFile?: string;
  modelTimeoutMs?: number;
  /** JSONL file for PrivateRecord lines (raw replies and quotes). Must be a path git ignores. */
  privateFile?: string;
  /** Model id to record with the run. */
  model?: string;
  /** Existing instruction variant (see answer/prompt.ts); default A. Only the system instructions change. */
  promptVariant?: PromptVariant;
  /** Which evidence the pipeline assembles; default 2, the behaviour of every run before version 3 existed. */
  evidenceVersion?: EvidenceVersion;
}

export type EvidenceVersion = 2 | 3;

/** Re-exported so that runs, the zero-call check and their tests name one constant; it is defined with the application's settings. */
export { V3_EVIDENCE };

/** `--evidence=v3` on the command line. Absent means version 2; anything else throws before anything runs. */
export function evidenceVersionFromArgs(args: string[]): EvidenceVersion {
  const flags = args.filter((x) => x === "--evidence" || x.startsWith("--evidence="));
  if (flags.length > 1) throw new Error("--evidence given more than once");
  if (flags.length === 0) return 2;
  if (flags[0] === "--evidence=v3") return 3;
  if (flags[0] === "--evidence=v2") return 2;
  throw new Error("unknown evidence version; expected exactly --evidence=v2 or --evidence=v3");
}

/** `--variant=B` on the command line. Absent means A; a repeated, bare or unknown value throws before anything runs. */
export function variantFromArgs(args: string[]): PromptVariant {
  const flags = args.filter((x) => x === "--variant" || x.startsWith("--variant="));
  if (flags.length > 1) throw new Error("--variant given more than once");
  const flag = flags[0];
  return parsePromptVariant(flag === undefined ? undefined : flag.startsWith("--variant=") ? flag.slice("--variant=".length) : "");
}

/**
 * Names for one real-model tuning run. The control A keeps the names its already-completed run used; B and C get a suffix, so a
 * checkpoint or result file can only ever hold one variant.
 */
export function tuningRunNames(split: Split, lo: number, hi: number, model: string, variant: PromptVariant, evidenceVersion: EvidenceVersion = 2): { variantName: string; checkpointName: string; privateName: string } {
  // Every name carries the prompt variant and the evidence contract, so a file can only ever hold results of one kind and the
  // runs made under the first contract (which had no such suffix) are never appended to or overwritten. A run on version 3
  // evidence adds "-v3"; version 2 runs keep the names they always had.
  const suffix = `-${variant}-e${EVIDENCE_CONTRACT}${evidenceVersion === 3 ? "-v3" : ""}`;
  const safeModel = model.replace(/[^A-Za-z0-9.-]+/g, "_");
  const stem = `answer-${split}-${lo}-${hi}-${safeModel}${suffix}`;
  return { variantName: `run-${lo}-${hi}${suffix}`, checkpointName: `${stem}.jsonl`, privateName: `${stem}.raw.jsonl` };
}

function readCheckpoint(file: string): Map<string, AnswerRecord> {
  const done = new Map<string, AnswerRecord>();
  if (!existsSync(file)) return done;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as AnswerRecord;
      if (typeof rec.id === "string" && rec.status !== "provider_error") done.set(rec.id, rec);
    } catch {
      // A torn last line from an interrupted write is simply not completed work.
    }
  }
  return done;
}

export async function runAnswers(split: Split, variant: PolicyVariant, provider: (declines: boolean) => ModelProvider, opts: RunOptions = {}): Promise<AnswerRun> {
  if (split === "holdout") assertFrozen();
  const questions = new Map(loadQuestions(split).map((q) => [q.id, q]));
  const specs = loadAnswerSpecs(split);
  const records: AnswerRecord[] = [];
  const providerFailures: { id: string; kind: string; status?: number; rateLimit?: RateLimitObservation }[] = [];
  let halted: AnswerRun["halted"];
  let resumed = 0;
  const done = opts.checkpointFile ? readCheckpoint(opts.checkpointFile) : new Map<string, AnswerRecord>();
  if (opts.checkpointFile) mkdirSync(path.dirname(opts.checkpointFile), { recursive: true });
  if (opts.privateFile) mkdirSync(path.dirname(opts.privateFile), { recursive: true });
  const repos = loadRepos().filter((r) => r.split === split);
  outer: for (const repo of repos) {
    const mine = specs.filter((s) => questions.get(s.id)?.repo === repo.repo);
    if (mine.length === 0) continue;
    if (mine.every((s) => done.has(s.id))) {
      for (const s of mine) records.push(done.get(s.id)!);
      resumed += mine.length;
      continue;
    }
    const [index, source] = await Promise.all([loadIndexFor(repo.repo, repo.sha), loadSource(repo.repo, repo.sha)]);
    const inner = provider(variant.captionDeclines);
    // Passes every request and reply through untouched; it only remembers the last provider error so its diagnostics can be recorded.
    let lastError: ProviderError | null = null;
    const model: ModelProvider = { name: inner.name, complete: async (r, sig) => { try { return await inner.complete(r, sig); } catch (e) { if (e instanceof ProviderError) lastError = e; throw e; } } };
    for (const s of mine) {
      lastError = null;
      const prior = done.get(s.id);
      if (prior) {
        records.push(prior);
        resumed += 1;
        continue;
      }
      const q = questions.get(s.id)!;
      let raw: string | null = null;
      const result = await answerQuestion(
        { index, repo: { ...parseRepoRef(repo.repo), sha: repo.sha }, source, provider: model, searchOptions: DEFAULT_SEARCH_OPTIONS, policy: variant.policy, ...(opts.modelTimeoutMs ? { modelTimeoutMs: opts.modelTimeoutMs } : {}), ...(opts.promptVariant ? { promptVariant: opts.promptVariant } : {}), ...(opts.evidenceVersion === 3 ? V3_EVIDENCE : {}), evidenceContract: EVIDENCE_CONTRACT, onModelOutput: (text) => (raw = text) },
        q.question,
      );
      if (opts.checkpointFile && result.status === "provider_error") {
        const kind = result.reasons[0]?.replace("model provider failed: ", "") ?? "unknown";
        const seen = lastError as ProviderError | null;
        providerFailures.push({ id: s.id, kind, ...(seen?.status ? { status: seen.status } : {}), ...(seen?.rateLimit ? { rateLimit: seen.rateLimit } : {}) });
        if (kind === "rate_limited") {
          halted = { nextId: s.id, reason: "rate or quota limit; resume later to continue from this case" };
          break outer;
        }
        continue;
      }
      const rec = record(q, s.mentions, result);
      records.push(rec);
      if (opts.privateFile) {
        const priv: PrivateRecord = {
          id: s.id,
          repo: repo.repo,
          sha: repo.sha,
          question: q.question,
          split,
          variant: variant.name,
          promptVariant: opts.promptVariant ?? "A",
          evidenceContract: EVIDENCE_CONTRACT,
          provider: model.name,
          model: opts.model ?? null,
          status: result.status,
          reasons: result.reasons,
          rejections: result.rejections,
          claims: result.claims,
          offered: result.evidence.map((e) => ({ id: e.id, path: e.path, startLine: e.startLine, endLine: e.endLine, injectionSuspect: e.injectionSuspect })),
          raw,
          stats: result.stats,
          recordedAt: new Date().toISOString(),
          ...(opts.evidenceVersion === 3 ? { evidenceVersion: 3 as const } : {}),
          ...(result.indexFacts ? { indexFacts: result.indexFacts } : {}),
        };
        // Written before the checkpoint line, so a case that is checkpointed always has its private record.
        appendFileSync(opts.privateFile, `${JSON.stringify(priv)}\n`);
      }
      if (opts.checkpointFile) appendFileSync(opts.checkpointFile, `${JSON.stringify(rec)}\n`);
    }
  }
  return {
    evidenceContract: EVIDENCE_CONTRACT,
    ...(opts.model ? { model: opts.model } : {}),
    provider: provider(false).name,
    variant: variant.name,
    split,
    createdAt: new Date().toISOString(),
    records,
    ...(opts.promptVariant ? { promptVariant: opts.promptVariant } : {}),
    ...(opts.evidenceVersion === 3 ? { evidenceVersion: 3 as const } : {}),
    ...(opts.checkpointFile ? { providerFailures, ...(halted ? { halted } : {}), total: specs.length, resumed } : {}),
  };
}

export function baselineProvider(declines: boolean): ModelProvider {
  return new ExtractiveBaselineProvider({ abstainOnLowCoverage: declines });
}

export interface AnswerMetrics {
  questions: number;
  positives: number;
  negatives: number;
  /** Citation chain, over every claim and citation the model produced */
  citations: { total: number; valid: number; fabricated: number; claims: number; claimsWithValidCitation: number };
  /** Answered positives only */
  evidencePrecision: number | null;
  referenceSupportedClaims: number | null;
  /** Policy/abstention */
  positivesAnswered: number;
  positivesRefused: number;
  negativesRefused: number;
  negativesAnswered: number;
  statusCounts: Record<string, number>;
  /** Positives answered with a valid answer that cites expected evidence and states the expected terms */
  correct: number;
  citesExpected: number;
  mentionsMet: number;
  rejectedAnswers: number;
  context: { medianChars: number; p95Chars: number; maxChars: number; medianPromptTokens: number; maxPromptTokens: number };
  latency: { medianRetrievalMs: number; medianSourceMs: number; medianValidateMs: number };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

export function scoreAnswers(records: AnswerRecord[]): AnswerMetrics {
  const positives = records.filter((r) => !r.negative);
  const negatives = records.filter((r) => r.negative);
  const answered = (r: AnswerRecord) => r.status === "answered";
  const refused = (r: AnswerRecord) => r.status === "insufficient_evidence" || r.status === "no_evidence";
  const allCitations = records.flatMap((r) => r.claims.flatMap((c) => c.citations));
  const allClaims = records.flatMap((r) => r.claims);
  const answeredPos = positives.filter(answered);
  const citedItems = answeredPos.flatMap((r) => r.cited.map((c) => ({ r, c })));
  const questions = new Map<string, BenchQuestion>([...loadQuestions("tuning"), ...loadQuestions("holdout")].map((q) => [q.id, q]));
  const supported = (r: AnswerRecord, c: { path: string; startLine: number; endLine: number }) => questions.get(r.id)!.expected.some((x) => overlaps(c, x));
  // A claim is reference-supported when at least one of ITS OWN valid citations overlaps the expected evidence.
  const claimSupported = answeredPos.flatMap((r) =>
    r.claims.map((cl) => cl.citations.some((ci) => ci.valid && r.offered.some((o) => o.id === ci.id && supported(r, o)))),
  );
  const statusCounts: Record<string, number> = {};
  for (const r of records) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  const chars = records.filter((r) => r.stats.modelCalled).map((r) => r.stats.evidenceChars);
  const prompt = records.filter((r) => r.stats.modelCalled).map((r) => r.stats.promptChars / 4);
  return {
    questions: records.length,
    positives: positives.length,
    negatives: negatives.length,
    citations: {
      total: allCitations.length,
      valid: allCitations.filter((c) => c.valid).length,
      fabricated: allCitations.filter((c) => !c.valid).length,
      claims: allClaims.length,
      claimsWithValidCitation: allClaims.filter((c) => c.citations.some((x) => x.valid)).length,
    },
    evidencePrecision: citedItems.length === 0 ? null : citedItems.filter(({ r, c }) => supported(r, c)).length / citedItems.length,
    referenceSupportedClaims: claimSupported.length === 0 ? null : claimSupported.filter(Boolean).length / claimSupported.length,
    positivesAnswered: positives.filter(answered).length,
    positivesRefused: positives.filter(refused).length,
    negativesRefused: negatives.filter(refused).length,
    negativesAnswered: negatives.filter(answered).length,
    statusCounts,
    correct: positives.filter((r) => answered(r) && r.citesExpected && r.mentionsMet).length,
    citesExpected: positives.filter((r) => answered(r) && r.citesExpected).length,
    mentionsMet: positives.filter((r) => answered(r) && r.mentionsMet).length,
    rejectedAnswers: records.filter((r) => r.status === "rejected").length,
    context: { medianChars: median(chars), p95Chars: pct(chars, 0.95), maxChars: Math.max(0, ...chars), medianPromptTokens: Math.round(median(prompt)), maxPromptTokens: Math.round(Math.max(0, ...prompt)) },
    latency: {
      medianRetrievalMs: median(records.map((r) => r.stats.retrievalMs)),
      medianSourceMs: median(records.map((r) => r.stats.sourceMs)),
      medianValidateMs: median(records.map((r) => r.stats.validateMs)),
    },
  };
}

export function saveRun(run: AnswerRun): string {
  mkdirSync(ANSWER_DIR, { recursive: true });
  const file = path.join(ANSWER_DIR, `answers.${run.provider}.${run.variant}.${run.split}.json`);
  writeFileSync(file, JSON.stringify(run));
  return file;
}

/**
 * Real GitHub check (not emulated): fetches the files behind a few questions' evidence at the pinned commit through the contents
 * API and confirms their fingerprints equal the ones recorded from the tarball at index time.
 */
export async function githubSourceCheck(repoName: string, questionIds: string[]): Promise<Record<string, unknown>> {
  const { GitHubRawSource } = await import("../answer/source");
  const { assembleEvidence } = await import("../answer/evidence");
  const { githubFetch } = await import("../github/client");
  const { search } = await import("../retrieve/search");
  const repo = loadRepos().find((r) => r.repo === repoName)!;
  const index = await loadIndexFor(repoName, repo.sha);
  const source = new GitHubRawSource();
  const questions = [...loadQuestions("tuning"), ...loadQuestions("holdout")].filter((q) => questionIds.includes(q.id));
  const rateRes = await githubFetch(new URL("https://api.github.com/rate_limit"));
  const rate = ((await rateRes.json()) as { resources: { core: { remaining: number; limit: number } } }).resources.core;
  let verified = 0;
  let rejected = 0;
  const reasons: Record<string, number> = {};
  const t0 = performance.now();
  for (const q of questions) {
    const r = search(index, q.question, { ...DEFAULT_SEARCH_OPTIONS, k: 10 });
    const out = await assembleEvidence({ index, repo: { ...parseRepoRef(repoName), sha: repo.sha }, candidates: r.evidence, source, maxItems: 4, budgetChars: 24_000 });
    verified += out.items.length;
    rejected += out.rejected.length;
    for (const x of out.rejected) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  }
  const ms = performance.now() - t0;
  return {
    repo: repoName,
    sha: repo.sha,
    rateLimitBefore: rate,
    questions: questions.length,
    githubRequests: source.metrics.requests,
    bytes: source.metrics.bytes,
    totalMs: Math.round(ms),
    msPerRequest: Math.round(ms / Math.max(1, source.metrics.requests)),
    evidenceVerified: verified,
    evidenceRejected: rejected,
    rejectedReasons: reasons,
  };
}

/** Prints source lines of a pinned repository from the cached tarball, with line numbers. Used when labelling evidence by hand. */
export async function viewLines(repoName: string, filePath: string, start: number, end: number): Promise<string> {
  const repo = loadRepos().find((r) => r.repo === repoName);
  if (!repo) throw new Error(`unknown repo ${repoName}`);
  const text = await (await loadSource(repoName, repo.sha)).getFile({ ...parseRepoRef(repoName), sha: repo.sha }, filePath);
  if (text === null) throw new Error(`no such file ${filePath}`);
  return text.split("\n").slice(start - 1, end).map((l, i) => `${start + i}| ${l.slice(0, 160)}`).join("\n");
}

const sourceCache = new Map<string, MapSource>();

/** Text of one file at the pinned commit of a dataset repository, read from the cached tarball. */
export async function loadSourceText(repoName: string, filePath: string): Promise<string | null> {
  const repo = loadRepos().find((r) => r.repo === repoName);
  if (!repo) throw new Error(`unknown repo ${repoName}`);
  let source = sourceCache.get(repoName);
  if (!source) {
    source = await loadSource(repoName, repo.sha);
    sourceCache.set(repoName, source);
  }
  return source.getFile({ ...parseRepoRef(repoName), sha: repo.sha }, filePath);
}
