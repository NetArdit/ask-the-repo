import type { LoadedIndex } from "../retrieve/loaded-index";
import { analyzeQuestion } from "../retrieve/query";
import { search, type AbstentionFeatures, type SearchOptions } from "../retrieve/search";
import { definitionCandidates, type DefinitionEvidenceOptions } from "./definitions";
import { declaringLine, entryCandidates, entryNote, findEntries, type EntryEvidenceOptions, type EntryFact } from "./entries";
import { assembleEvidence, permalink, type RejectedCandidate } from "./evidence";
import { findImporters, importerCandidates, importerNote, type ImporterEvidenceOptions, type ImporterFact } from "./importers";
import { isOverviewQuestion, overviewCandidates, structureNote, type OverviewEvidenceOptions } from "./overview";
import { ProviderError, type ModelProvider } from "./provider";
import { englishKeywords, looksNonEnglish, repairInstruction, repairQuotes } from "./resilience";
import { decideSufficiency, type PolicyConfig, type SufficiencyDecision } from "./policy";
import { buildPrompt, type PromptVariant } from "./prompt";
import type { SourceProvider } from "./source";
import type { AnswerStatus, ClaimVerdict, Rejection, RepoIdentity, ValidatedAnswer } from "./types";
import { DEFAULT_EVIDENCE_CONTRACT, EvidenceRegistry, parseModelOutput, validateAnswer, type EvidenceContract, type ValidationOptions } from "./validate";

export interface AnswerDeps {
  index: LoadedIndex;
  repo: RepoIdentity;
  source: SourceProvider;
  provider: ModelProvider;
  searchOptions: SearchOptions;
  policy: PolicyConfig;
  maxEvidence?: number;
  /** Characters of source placed in the prompt. Roughly four characters per token. */
  evidenceBudgetChars?: number;
  modelTimeoutMs?: number;
  maxOutputTokens?: number;
  validation?: ValidationOptions;
  /** Which evidence contract the reply is held to (see validate.ts). Absent means the application's, which is what the web routes use. */
  evidenceContract?: EvidenceContract;
  /** Instruction variant for the model; default A. */
  promptVariant?: PromptVariant;
  /**
   * Benchmark version 3, change 1: also offer the definitions of functions the retrieved lines call. Absent (the default) means
   * version 2 behaviour, exactly: the web application and every recorded run leave it absent.
   */
  definitionEvidence?: DefinitionEvidenceOptions;
  /** Benchmark version 3, change 2: answer "who imports X" from the index's import table. Absent means version 2 behaviour. */
  importerEvidence?: ImporterEvidenceOptions;
  /** Benchmark version 3, change 3: answer "what is the entry point" from the declared entries in the index. Absent means version 2 behaviour. */
  entryEvidence?: EntryEvidenceOptions;
  /**
   * Questions about the whole repository ("what does this project do?") are answered from the README, the manifest and the entry
   * points, which are offered ahead of whatever the words of the question retrieve, and are not refused for low word coverage.
   * Absent means every question is treated as before, exactly: the benchmark and every recorded run leave it absent.
   */
  overview?: OverviewEvidenceOptions;
  /**
   * The web application's forgiveness for a model that slips. A quote that is not word for word in its block is cut to the part
   * that is; a reply that fails a check gets one second try with the failed checks named; and if claims still fail, the claims that
   * passed every check are shown with a note, instead of the whole answer being withheld. Every quote that reaches the reader is
   * still checked to occur word for word in the lines it cites. Absent means none of this: the benchmark and recorded runs leave it absent.
   */
  resilient?: boolean;
  /** A question that is probably not in English is first turned into English search words by one small model call. Absent means never. */
  queryExpansion?: boolean;
  /**
   * Receives the model's reply exactly as it came, before parsing. For evaluation runs that keep private diagnostics. The reply
   * is never part of the result, so nothing a caller returns to a client can contain it by accident.
   */
  onModelOutput?: (raw: string) => void;
}

export interface CitedEvidence {
  id: string;
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
  injectionSuspect: boolean;
}

/** Something the application read from the index and states itself, beside whatever the model says. */
export type IndexFact = ImporterFact | EntryFact;

export interface AnswerResult {
  /**
   * Version 3 only: facts the application took from the index for this question (for example every file that imports a name).
   * They are the application's statement, not the model's, and are not claims: nothing here was cited or validated.
   */
  indexFacts?: IndexFact[];
  status: AnswerStatus;
  /** Claims exactly as the model made them, with each citation's verdict. Present for answered and rejected results. */
  claims: ClaimVerdict[];
  reasons: string[];
  /** Why the reply was not accepted, structured: one entry per failed check. Empty for an accepted answer. */
  rejections: Rejection[];
  /**
   * Things a reader should know about an accepted answer. A claim that rests only on instruction-like evidence is flagged here: its
   * citations are valid, but that says nothing about whether the claim is true. A keyword heuristic, so absence of a warning proves nothing.
   */
  warnings: string[];
  missing?: string;
  unsupported?: string[];
  /** Every evidence item offered to the model, with application-built permalinks. */
  evidence: CitedEvidence[];
  rejectedEvidence: RejectedCandidate[];
  policy: SufficiencyDecision;
  features: AbstentionFeatures;
  provider: string;
  stats: {
    retrievalMs: number;
    sourceMs: number;
    modelMs: number;
    validateMs: number;
    evidenceCount: number;
    evidenceChars: number;
    omittedForBudget: number;
    promptChars: number;
    modelCalled: boolean;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

const DEFAULT_MAX_EVIDENCE = 8;
/** For a question about the whole repository, how many blocks found by the question's words may follow the introducing files. Words rarely matter here. */
const OVERVIEW_RETRIEVED = 2;
const DEFAULT_BUDGET_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1_200;

/**
 * question -> retrieve -> verify evidence at the pinned commit -> model -> validate citations.
 * Nothing in here logs; prompts, evidence text and model output are returned to the caller or dropped.
 */
export async function answerQuestion(deps: AnswerDeps, question: string): Promise<AnswerResult> {
  const t0 = performance.now();
  let searchText = question;
  if (deps.queryExpansion === true && looksNonEnglish(question)) {
    const words = await englishKeywords(deps.provider, question, AbortSignal.timeout(Math.min(deps.modelTimeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000)));
    // The question's own words that are not in the repository at all (its Albanian, German, ...) only dilute the coverage score.
    // Keep the ones the index knows, so English or code words mixed into the question still count, and its identifiers.
    const own = analyzeQuestion(question, deps.index.stemMode);
    const known = own.terms.filter((t) => deps.index.documentFrequency(t) > 0);
    if (words.length > 0) searchText = [...new Set([...words, ...own.identifiers, ...known])].join(" ");
  }
  const result = search(deps.index, searchText, { ...deps.searchOptions, k: 10 });
  const base = {
    claims: [] as ClaimVerdict[],
    reasons: [] as string[],
    rejections: [] as Rejection[],
    warnings: [] as string[],
    evidence: [] as CitedEvidence[],
    rejectedEvidence: [] as RejectedCandidate[],
    features: result.features,
    provider: deps.provider.name,
  };
  const stats = {
    retrievalMs: performance.now() - t0,
    sourceMs: 0,
    modelMs: 0,
    validateMs: 0,
    evidenceCount: 0,
    evidenceChars: 0,
    omittedForBudget: 0,
    promptChars: 0,
    modelCalled: false,
    /** Provider-reported token counts; null when the provider does not report them */
    inputTokens: null as number | null,
    outputTokens: null as number | null,
  };

  const overview = deps.overview !== undefined && isOverviewQuestion(question);
  const overviewBlocks = overview ? overviewCandidates(deps.index, deps.overview!) : [];
  const policy: SufficiencyDecision = overview && overviewBlocks.length > 0
    ? { action: "answer", reason: "question about the whole repository" }
    : decideSufficiency(result.features, result.evidence.length, deps.policy);
  if (policy.action === "insufficient") return { ...base, status: "insufficient_evidence", policy, stats };

  const t1 = performance.now();
  const budgetChars = deps.evidenceBudgetChars ?? DEFAULT_BUDGET_CHARS;
  const assembled = await assembleEvidence({
    index: deps.index,
    repo: deps.repo,
    candidates: overview ? [...overviewBlocks, ...result.evidence.filter((e) => !overviewBlocks.some((o) => o.chunkId === e.chunkId)).slice(0, OVERVIEW_RETRIEVED)] : result.evidence,
    source: deps.source,
    maxItems: deps.maxEvidence ?? DEFAULT_MAX_EVIDENCE,
    budgetChars,
  });
  // Version 3 additions. Each names more chunks, which are verified against the commit like any other block, numbered after the
  // retrieved blocks, and admitted only inside what is left of the same character budget: they can add evidence, never displace it.
  const addBlocks = async (wanted: Parameters<typeof assembleEvidence>[0]["candidates"], maxBlocks: number) => {
    if (wanted.length === 0 || assembled.totalChars >= budgetChars) return;
    const extra = await assembleEvidence({ index: deps.index, repo: deps.repo, candidates: wanted, source: deps.source, maxItems: maxBlocks, budgetChars: budgetChars - assembled.totalChars });
    for (const item of extra.items) {
      if (assembled.totalChars + item.text.length > budgetChars) {
        assembled.omittedForBudget += 1;
        continue;
      }
      assembled.items.push({ ...item, id: `E${assembled.items.length + 1}` });
      assembled.totalChars += item.text.length;
    }
    assembled.rejected.push(...extra.rejected);
  };
  const indexFacts: IndexFact[] = [];
  const indexNotes: string[] = [];
  if (assembled.items.length > 0) {
    if (overview) indexNotes.push(structureNote(deps.index));
    if (deps.importerEvidence) {
      // Who imports what the question asks about, read from the import table rather than inferred from whatever was retrieved.
      const fact = findImporters(deps.index, question);
      if (fact) {
        await addBlocks(importerCandidates(deps.index, fact, assembled.items, deps.importerEvidence), deps.importerEvidence.maxBlocks);
        indexFacts.push(fact);
        indexNotes.push(importerNote(fact, assembled.items));
      }
    }
    if (deps.entryEvidence) {
      // The declared entry points of the package asked about, and the manifest lines that declare them.
      const fact = findEntries(deps.index, question, deps.repo.repo);
      if (fact) {
        const declLine = await declaringLine(fact, (p) => deps.source.getFile(deps.repo, p));
        await addBlocks(entryCandidates(deps.index, fact, declLine, assembled.items, deps.entryEvidence), deps.entryEvidence.maxBlocks);
        indexFacts.push(fact);
        indexNotes.push(entryNote(fact, declLine, assembled.items));
      }
    }
    if (deps.definitionEvidence) {
      // Definitions of what the retrieved lines call.
      await addBlocks(definitionCandidates(deps.index, assembled.items, question, deps.definitionEvidence), deps.definitionEvidence.maxBlocks);
    }
  }
  stats.sourceMs = performance.now() - t1;
  stats.evidenceCount = assembled.items.length;
  stats.evidenceChars = assembled.totalChars;
  stats.omittedForBudget = assembled.omittedForBudget;
  const evidence: CitedEvidence[] = assembled.items.map((e) => ({
    id: e.id,
    key: e.key,
    path: e.path,
    startLine: e.startLine,
    endLine: e.endLine,
    url: permalink(e),
    injectionSuspect: e.injectionSuspect,
  }));
  const withEvidence = { ...base, evidence, rejectedEvidence: assembled.rejected, policy, ...(indexFacts.length > 0 ? { indexFacts } : {}) };
  if (assembled.items.length === 0) {
    return { ...withEvidence, status: "no_evidence", reasons: ["no retrieved span could be verified against the commit"], stats };
  }

  const prompt = buildPrompt(question, deps.repo, assembled.items, { lowCoverage: policy.action === "caution", variant: deps.promptVariant, ...(indexNotes.length > 0 ? { indexNotes } : {}) });
  stats.promptChars = prompt.system.length + prompt.user.length;
  const t2 = performance.now();
  stats.modelCalled = true;
  let raw: string;
  try {
    raw = await deps.provider.complete(
      { system: prompt.system, user: prompt.user, maxTokens: deps.maxOutputTokens ?? DEFAULT_MAX_TOKENS, nonce: prompt.nonce, onUsage: (u) => { stats.inputTokens = u.inputTokens; stats.outputTokens = u.outputTokens; } },
      AbortSignal.timeout(deps.modelTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
  } catch (err) {
    stats.modelMs = performance.now() - t2;
    const kind = err instanceof ProviderError ? err.kind : "network";
    return { ...withEvidence, status: "provider_error", reasons: [`model provider failed: ${kind}`], rejections: [{ code: "provider-error", detail: kind }], stats };
  }
  stats.modelMs = performance.now() - t2;
  deps.onModelOutput?.(raw);

  const t3 = performance.now();
  const contract = deps.evidenceContract ?? DEFAULT_EVIDENCE_CONTRACT;
  const registry = new EvidenceRegistry(assembled.items, deps.repo);
  const resilient = deps.resilient === true;
  type Judged = { malformed: { reason: string; code?: "quote-too-long" } | null; validated: ValidatedAnswer | null; repaired: number };
  const judge = (text: string): Judged => {
    const p = parseModelOutput(text, contract);
    if (!p.ok) return { malformed: { reason: p.reason, ...(p.code ? { code: p.code } : {}) }, validated: null, repaired: 0 };
    const fixed = resilient ? repairQuotes(p.output, assembled.items) : { output: p.output, repaired: 0 };
    return { malformed: null, validated: validateAnswer(fixed.output, registry, deps.validation), repaired: fixed.repaired };
  };
  const failed = (j: Judged): boolean => j.malformed !== null || j.validated!.status === "rejected";
  const goodClaims = (j: Judged): number => (j.validated ? j.validated.claims.filter((c) => c.status === "cited" && c.quoteVerbatim === true).length : 0);
  const notes: string[] = [];
  let judged = judge(raw);
  if (resilient && failed(judged)) {
    // One second try, told which checks failed. Its reply is held to the same checks; nothing is relaxed for it.
    const problems = judged.malformed ? [`the reply did not match the required JSON shape (${judged.malformed.reason})`] : judged.validated!.reasons;
    const t4 = performance.now();
    try {
      const raw2 = await deps.provider.complete(
        { system: prompt.system, user: `${prompt.user}
${repairInstruction(prompt.nonce, problems)}`, maxTokens: deps.maxOutputTokens ?? DEFAULT_MAX_TOKENS, nonce: prompt.nonce, onUsage: (u) => { stats.inputTokens = u.inputTokens; stats.outputTokens = u.outputTokens; } },
        AbortSignal.timeout(deps.modelTimeoutMs ?? DEFAULT_TIMEOUT_MS),
      );
      stats.modelMs += performance.now() - t4;
      deps.onModelOutput?.(raw2);
      const second = judge(raw2);
      if (!failed(second) || (judged.validated === null && second.validated !== null) || (second.validated !== null && judged.validated !== null && goodClaims(second) > goodClaims(judged))) judged = second;
      notes.push("The model's first reply failed a check, so it was asked once to correct it.");
    } catch {
      stats.modelMs += performance.now() - t4;
    }
  }
  if (judged.malformed) {
    stats.validateMs = performance.now() - t3;
    return { ...withEvidence, status: "rejected", reasons: [`malformed model output: ${judged.malformed.reason}`], rejections: [{ code: judged.malformed.code ?? "malformed-output", detail: judged.malformed.reason }], warnings: notes, stats };
  }
  let validated = judged.validated!;
  if (resilient && validated.status === "rejected") {
    // Claims that passed every check stand; the others are left out and the reader is told. Nothing unchecked is shown.
    const kept = validated.claims.filter((c) => c.status === "cited" && c.quoteVerbatim === true);
    if (kept.length > 0) {
      const dropped = validated.claims.length - kept.length;
      notes.push(`${dropped} claim${dropped === 1 ? " was" : "s were"} left out because its quote could not be matched word for word to the cited lines.`);
      validated = { ...validated, status: "answered", claims: kept, reasons: [], rejections: [] };
    }
  }
  if (judged.repaired > 0) notes.push(`${judged.repaired} quote${judged.repaired === 1 ? " was" : "s were"} cut to the part that appears word for word in the cited lines.`);
  stats.validateMs = performance.now() - t3;
  const suspect = new Set(assembled.items.filter((e) => e.injectionSuspect).map((e) => e.id));
  const warnings: string[] = [...notes];
  if (validated.status === "answered") {
    validated.claims.forEach((c, i) => {
      const valid = c.citations.filter((x) => x.verdict.valid);
      if (valid.length > 0 && valid.every((x) => suspect.has(x.id))) warnings.push(`claim ${i + 1} rests only on evidence that reads like an instruction to a model`);
    });
  }
  return { ...withEvidence, status: validated.status, claims: validated.claims, reasons: validated.reasons, rejections: validated.rejections, warnings, missing: validated.missing, unsupported: validated.unsupported, stats };
}
