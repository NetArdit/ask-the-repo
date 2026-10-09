import type { LoadedIndex } from "../retrieve/loaded-index";
import { search, type AbstentionFeatures, type SearchOptions } from "../retrieve/search";
import { definitionCandidates, type DefinitionEvidenceOptions } from "./definitions";
import { declaringLine, entryCandidates, entryNote, findEntries, type EntryEvidenceOptions, type EntryFact } from "./entries";
import { assembleEvidence, permalink, type RejectedCandidate } from "./evidence";
import { findImporters, importerCandidates, importerNote, type ImporterEvidenceOptions, type ImporterFact } from "./importers";
import { ProviderError, type ModelProvider } from "./provider";
import { decideSufficiency, type PolicyConfig, type SufficiencyDecision } from "./policy";
import { buildPrompt, type PromptVariant } from "./prompt";
import type { SourceProvider } from "./source";
import type { AnswerStatus, ClaimVerdict, Rejection, RepoIdentity } from "./types";
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
const DEFAULT_BUDGET_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1_200;

/**
 * question -> retrieve -> verify evidence at the pinned commit -> model -> validate citations.
 * Nothing in here logs; prompts, evidence text and model output are returned to the caller or dropped.
 */
export async function answerQuestion(deps: AnswerDeps, question: string): Promise<AnswerResult> {
  const t0 = performance.now();
  const result = search(deps.index, question, { ...deps.searchOptions, k: 10 });
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

  const policy = decideSufficiency(result.features, result.evidence.length, deps.policy);
  if (policy.action === "insufficient") return { ...base, status: "insufficient_evidence", policy, stats };

  const t1 = performance.now();
  const budgetChars = deps.evidenceBudgetChars ?? DEFAULT_BUDGET_CHARS;
  const assembled = await assembleEvidence({
    index: deps.index,
    repo: deps.repo,
    candidates: result.evidence,
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
  const parsed = parseModelOutput(raw, deps.evidenceContract ?? DEFAULT_EVIDENCE_CONTRACT);
  if (!parsed.ok) {
    stats.validateMs = performance.now() - t3;
    return { ...withEvidence, status: "rejected", reasons: [`malformed model output: ${parsed.reason}`], rejections: [{ code: parsed.code ?? "malformed-output", detail: parsed.reason }], stats };
  }
  const validated = validateAnswer(parsed.output, new EvidenceRegistry(assembled.items, deps.repo), deps.validation);
  stats.validateMs = performance.now() - t3;
  const suspect = new Set(assembled.items.filter((e) => e.injectionSuspect).map((e) => e.id));
  const warnings: string[] = [];
  if (validated.status === "answered") {
    validated.claims.forEach((c, i) => {
      const valid = c.citations.filter((x) => x.verdict.valid);
      if (valid.length > 0 && valid.every((x) => suspect.has(x.id))) warnings.push(`claim ${i + 1} rests only on evidence that reads like an instruction to a model`);
    });
  }
  return { ...withEvidence, status: validated.status, claims: validated.claims, reasons: validated.reasons, rejections: validated.rejections, warnings, missing: validated.missing, unsupported: validated.unsupported, stats };
}
