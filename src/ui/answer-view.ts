import type { AnswerResult, CitedEvidence } from "../answer/answer";
import type { ClaimVerdict, Rejection } from "../answer/types";
import { MAX_SUGGESTIONS, MAX_TEXT, NEXT_STEP_COPY, cleanText } from "../answer/next-steps";
import { validatePrevious, type Previous } from "../answer/followup";
import type { ApiFailure } from "./api";

/** How an answer is framed for the reader. "withheld" and "unavailable" are never shown as answers. */
export type AnswerTone = "answered" | "insufficient" | "withheld" | "unavailable";

export interface ViewCitation {
  id: string;
  valid: boolean;
  /** The evidence the id refers to; absent when the model cited something that was never offered. */
  evidence: CitedEvidence | null;
  /** The passage the model quoted from that evidence. */
  quote: string;
  /** Whether that passage really occurs in that evidence. A structural fact; it says nothing about whether it supports the claim. */
  quoteVerbatim: boolean;
  /** The model quoted more than is kept; what is shown is the first part, cut after the whole quote was checked. */
  quoteTrimmed: boolean;
}

export interface ViewClaim {
  text: string;
  citations: ViewCitation[];
  /** What the server checked for this claim, in the reader's words. */
  check: string;
  passed: boolean;
}

/** A closest file shown after a refusal. A pointer to a place to look, never evidence. */
export interface ViewLead {
  path: string;
  startLine: number;
  endLine: number;
  rank: number;
}

/** One suggested question: `label` is the visible button text, `question` is what the button asks. Plain text only. */
export interface ViewSuggestion {
  label: string;
  question: string;
}

/** W-13 next steps after a refusal. Absent from the view when the server sent none. */
export interface ViewNextSteps {
  heading: string;
  suggestions: ViewSuggestion[];
}

export interface AnswerView {
  /** Only when the server sent at least one usable suggestion. */
  nextSteps?: ViewNextSteps;
  tone: AnswerTone;
  title: string;
  /** One or two plain sentences on what happened. */
  detail: string;
  claims: ViewClaim[];
  /** What the model said the evidence lacks, when it said so. */
  missing: string | null;
  /** Why an answer was withheld, in the reader's words. */
  reasons: string[];
  warnings: string[];
  evidence: CitedEvidence[];
  citedIds: string[];
  canRetry: boolean;
  /**
   * What the application itself read from its index for this question, in the reader's words. Not the model's claims: nothing
   * here was cited or checked against a quote, and the index can miss things (an import it could not resolve, for one).
   */
  facts: string[];
  /** Closest files after a refusal before the model was asked; empty when there are none. Not evidence. */
  leads: ViewLead[];
}

const MAX_VIEW_LEADS = 5;
const MAX_VIEW_LEAD_PATH = 200;

/** Leads from a result kept in the browser or sent by a server: nothing is trusted. Control characters removed, path cut, at most five. */
export function describeLeads(raw: unknown): ViewLead[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewLead[] = [];
  for (const l of raw) {
    if (out.length >= MAX_VIEW_LEADS) break;
    if (typeof l !== "object" || l === null) continue;
    const { path, startLine, endLine, rank } = l as Record<string, unknown>;
    if (typeof path !== "string" || typeof startLine !== "number" || typeof endLine !== "number" || typeof rank !== "number") continue;
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || !Number.isFinite(rank)) continue;
    let p = path.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_VIEW_LEAD_PATH);
    const last = p.charCodeAt(p.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) p = p.slice(0, -1);
    if (p === "") continue;
    out.push({ path: p, startLine, endLine, rank });
  }
  return out;
}

/** Next steps from a result kept in the browser or sent by a server: nothing is trusted. Text cleaned and cut to 120 characters, at most three, none when nothing usable is left. */
export function describeNextSteps(raw: unknown): ViewNextSteps | null {
  if (typeof raw !== "object" || raw === null) return null;
  const list = (raw as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return null;
  const suggestions: ViewSuggestion[] = [];
  for (const s of list) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (typeof s !== "object" || s === null) continue;
    const { label, question } = s as Record<string, unknown>;
    if (typeof label !== "string" || typeof question !== "string") continue;
    const l = cleanText(label, MAX_TEXT);
    const q = cleanText(question, MAX_TEXT);
    if (l !== "" && q !== "") suggestions.push({ label: l, question: q });
  }
  return suggestions.length === 0 ? null : { heading: NEXT_STEP_COPY.refusal, suggestions };
}

/** Section 5.3, state 3: the clarifying question. Built here for the card that will show it; no current result triggers it. */
export function clarifyText(phrase: string): string {
  return NEXT_STEP_COPY.clarify(phrase);
}

/** Section 5.3, state 2: the note above "ask again" and "ask something new". No current result triggers it. */
export function followUpNote(previousQuestion: string): string {
  return NEXT_STEP_COPY.followUp(previousQuestion);
}

/**
 * W-11: the previous turn as the server accepts it, taken from the newest entry of this repository's thread (callers pass the entries that
 * come before the question being asked, newest first). Only a finished result counts: a pending, failed, withheld or unavailable turn gives
 * nothing. An answer contributes the files its valid citations point to, up to five; a refusal contributes the question only.
 */
export function previousTurn(thread: readonly { question: string; outcome: { kind: string; result?: AnswerResult } }[]): Previous | null {
  const last = thread[0];
  if (last === undefined || last.outcome.kind !== "result" || last.outcome.result === undefined) return null;
  const result = last.outcome.result;
  if (result.status === "insufficient_evidence" || result.status === "no_evidence") return validatePrevious({ question: last.question, outcome: "refused", files: [] });
  if (result.status !== "answered" || !Array.isArray(result.claims) || !Array.isArray(result.evidence)) return null;
  const byId = new Map(result.evidence.map((e) => [e.id, e]));
  const files: { path: string; startLine: number; endLine: number }[] = [];
  for (const c of result.claims) {
    for (const x of Array.isArray(c.citations) ? c.citations : []) {
      const e = x.verdict?.valid ? byId.get(x.id) : undefined;
      if (e !== undefined && !files.some((f) => f.path === e.path && f.startLine === e.startLine && f.endLine === e.endLine)) files.push({ path: e.path, startLine: e.startLine, endLine: e.endLine });
    }
  }
  return validatePrevious({ question: last.question, outcome: "answered", files });
}

/** W-11: the one line above an answer that used the previous turn. Absent when the server said nothing about a follow-up, or did not inherit. */
export function describeFollowup(result: { followup?: unknown }): { note: string } | null {
  const f = result.followup;
  if (typeof f !== "object" || f === null) return null;
  const { inherited, from } = f as { inherited?: unknown; from?: unknown };
  if (inherited !== true || typeof from !== "string" || cleanText(from, MAX_TEXT) === "") return null;
  return { note: NEXT_STEP_COPY.followUp(from) };
}

/** Section 5.3, state 5: the first-time out-of-scope notice, without the pause warning (that is W-15). */
export const SCOPE_NOTICE: string = NEXT_STEP_COPY.scopeNotice;

const MAX_LISTED = 6;
function listed(items: string[]): string {
  return items.length <= MAX_LISTED ? items.join(", ") : `${items.slice(0, MAX_LISTED).join(", ")} and ${items.length - MAX_LISTED} more`;
}

/** One fact from the index as a sentence. Built from the fact's fields only; file names are shown as they are. */
export function describeFact(fact: NonNullable<AnswerResult["indexFacts"]>[number]): string {
  if (fact.kind === "importers") {
    const source = fact.files.filter((f) => f.source).map((f) => f.path);
    const other = fact.files.length - source.length;
    const elsewhere = other === 0 ? "" : `${source.length > 0 ? ", and " : ""}${other} ${other === 1 ? "file" : "files"} in tests, examples or docs`;
    const inSource = source.length === 0 ? "" : `${source.length} source ${source.length === 1 ? "file" : "files"} (${listed(source)})`;
    return `The index lists ${fact.files.length} ${fact.files.length === 1 ? "file" : "files"} importing ${fact.target}: ${inSource}${elsewhere}.`;
  }
  const entries = fact.entries.map((e) => `${e.entryKind}: ${e.path}`);
  return `Entry points of the package ${fact.pkg}, as the index resolved them: ${listed(entries)}.${fact.manifest ? ` Its manifest is ${fact.manifest}.` : ""}`;
}

/** A quote this short (ignoring spaces) occurs in almost any block, so finding it there says little about the claim. */
export const SHORT_QUOTE_CHARS = 20;
export function isShortQuote(quote: string): boolean {
  return quote.replace(/\s+/g, "").length < SHORT_QUOTE_CHARS;
}

function claimCheck(c: ClaimVerdict): { check: string; passed: boolean } {
  if (c.status === "cited") return { passed: true, check: "Each quote appears, word for word, in the lines it cites at this commit." };
  if (c.status === "quote-mismatch") return { passed: false, check: "A quote does not appear in the lines it is attributed to." };
  if (c.status === "invalid-citation") return { passed: false, check: "It cited evidence that does not exist." };
  return { passed: false, check: "It gave no evidence." };
}

/** One failed check, in the reader's words. Built from the server's codes, never from its wording. */
function readableRejection(r: Rejection): string {
  const claim = r.claim === undefined ? "" : `Claim ${r.claim}: `;
  switch (r.code) {
    case "malformed-output":
      return "The model's reply was not in the required format.";
    case "quote-too-long":
      return "The model quoted more than the allowed length, so the answer was withheld.";
    case "uncited-claim":
      return `${claim}it gives no evidence.`;
    case "invalid-citation":
      return `${claim}it cites ${r.citation ?? "an id"}, which was not among the evidence provided.`;
    case "quote-not-in-citation":
      return `${claim}the quoted text is not in ${r.citation ?? "the block"}, the evidence it is attributed to.`;
    case "provider-error":
      return "The model could not be reached.";
  }
}

/** A clock time rather than "in N seconds", so the sentence stays true however long the card has been on the page. */
export function retryTime(retryAt: number): string {
  return new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function providerProblem(reasons: string[], retryAt?: number): { title: string; detail: string } {
  const kind = (reasons[0] ?? "").replace("model provider failed: ", "");
  if (kind === "rate_limited") {
    // The model's own wait when it stated one; otherwise the usual length of its per-minute window.
    const when = retryAt !== undefined && Number.isFinite(retryAt) ? `The model said to try again after ${retryTime(retryAt)}.` : "Try again in a minute.";
    return { title: "The model is rate limited right now", detail: `The language model's usage limit was reached, so this question was not answered. The evidence below was still retrieved. ${when}` };
  }
  if (kind === "timeout") return { title: "The model took too long", detail: "The language model did not reply in time, so this question was not answered. The evidence below was still retrieved." };
  if (kind === "blocked") return { title: "The model declined this request", detail: "The language model refused to process this question and its evidence. Nothing was answered." };
  return { title: "The model could not be reached", detail: "The language model returned an error, so this question was not answered. The evidence below was still retrieved." };
}

export function describeAnswer(result: AnswerResult, retryAt?: number, question?: string): AnswerView {
  const byId = new Map(result.evidence.map((e) => [e.id, e]));
  const claims: ViewClaim[] = result.claims.map((c) => ({
    text: c.text,
    // Results kept in the browser from before quotes travelled with citations have none; they show as empty.
    citations: c.citations.map((x) => ({ id: x.id, valid: x.verdict.valid, evidence: byId.get(x.id) ?? null, quote: x.quote ?? "", quoteVerbatim: x.quoteVerbatim ?? false, quoteTrimmed: x.quoteTrimmed === true })),
    ...claimCheck(c),
  }));
  const citedIds = [...new Set(result.claims.flatMap((c) => c.citations.filter((x) => x.verdict.valid).map((x) => x.id)))];
  // Results kept in the browser from before the application stated facts have none.
  const facts = Array.isArray(result.indexFacts) ? result.indexFacts.map(describeFact) : [];
  // Results kept in the browser from before next steps existed have none.
  const found = describeNextSteps(result.nextSteps);
  // W-11: a clarifying question (section 5.3 state 3) names the words the reader typed. Only when the caller gave the question.
  const clarify = found !== null && result.nextSteps?.kind === "clarify" && question !== undefined && cleanText(question, MAX_TEXT) !== "" ? NEXT_STEP_COPY.clarify(question) : null;
  const steps = found !== null && clarify !== null ? { ...found, heading: clarify } : found;
  const base = { claims, missing: result.missing ?? null, reasons: [] as string[], warnings: result.warnings, evidence: result.evidence, citedIds, canRetry: false, facts, leads: describeLeads(result.leads), ...(steps === null ? {} : { nextSteps: steps }) };

  switch (result.status) {
    case "answered":
      return { ...base, tone: "answered", title: "Answer", detail: "" };
    case "insufficient_evidence":
      return result.stats.modelCalled
        ? { ...base, tone: "insufficient", title: "Not enough evidence to answer", detail: "The model read the evidence below and found that it does not answer the question." }
        : {
            ...base,
            tone: "insufficient",
            title: clarify === null ? "Not enough evidence to answer" : "Which topic do you mean?",
            detail: steps === null ? "The search matched too little of this repository to support an answer, so the model was not asked. Try naming a function, file or option that appears in the code." : clarify ?? NEXT_STEP_COPY.refusal,
          };
    case "no_evidence":
      return { ...base, tone: "insufficient", title: "No evidence could be verified", detail: "Matching files were found, but none could be confirmed against the repository at this commit." };
    case "rejected":
      return {
        ...base,
        tone: "withheld",
        title: "Answer withheld",
        detail: "The model replied, but its reply failed a citation check, so it is not presented as an answer.",
        reasons: (result.rejections ?? []).map(readableRejection),
        canRetry: true,
      };
    case "provider_error":
      return { ...base, tone: "unavailable", ...providerProblem(result.reasons, retryAt), claims: [], canRetry: true };
  }
}

export type FailureContext = "ingest" | "status" | "answer" | "source";

export interface FailureView {
  title: string;
  detail: string;
  canRetry: boolean;
}

function wait(seconds: number | null): string {
  if (seconds === null) return "Wait a moment and try again.";
  if (seconds < 90) return `Try again in about ${seconds} seconds.`;
  return seconds < 5400 ? `Try again in about ${Math.ceil(seconds / 60)} minutes.` : `Try again in about ${Math.ceil(seconds / 3600)} hours.`;
}

/** Turns a failed request into words. Server text is passed through only where the server wrote it for a person to read. */
export function describeFailure(f: ApiFailure, context: FailureContext): FailureView {
  // W-13: when the server named what to do, the plain copy of section 5.3 (states 7, 9, 10) is shown. Without a marker nothing changes.
  if (f.guidance === "wait") return { title: "Please wait", detail: NEXT_STEP_COPY.wait(f.retryAfterSeconds ?? 1), canRetry: true };
  if (f.guidance === "busy") return { title: "The server is busy", detail: NEXT_STEP_COPY.busy(f.retryAfterSeconds ?? 1), canRetry: true };
  if (f.guidance === "error") return { title: "Something went wrong", detail: NEXT_STEP_COPY.error, canRetry: true };
  switch (f.kind) {
    case "invalid":
      return { title: "That request was not accepted", detail: f.serverMessage ?? "Check what you entered and try again.", canRetry: false };
    case "not_found":
      return context === "ingest"
        ? { title: "Repository or commit not found", detail: "GitHub has no public repository with that name, or no such commit in it. Check the spelling. Private repositories are not supported.", canRetry: false }
        : { title: "Not found", detail: "That file or commit is not available.", canRetry: false };
    case "not_indexed":
      return { title: "This commit is not indexed on this server", detail: "Index it to ask questions about it.", canRetry: false };
    case "too_large":
      return context === "ingest"
        ? { title: "This repository is too large to index", detail: "It exceeds the size or time limit for indexing. Try a smaller repository.", canRetry: false }
        : { title: "That request is too large", detail: "Shorten it and try again.", canRetry: false };
    case "unprocessable":
      return { title: "This repository cannot be indexed", detail: "It may be empty, with no commits yet.", canRetry: false };
    case "rate_limited":
      return { title: "Too many requests", detail: `This server limits how often it can be asked. ${wait(f.retryAfterSeconds)}`, canRetry: true };
    case "daily_limit":
      return { title: "Daily answer limit reached", detail: `This server has used its allowance of answers for today. ${f.retryAfterSeconds === null ? "Answers will return later." : wait(f.retryAfterSeconds)}`, canRetry: false };
    case "busy":
      return { title: "The server is busy", detail: `It is working on other requests. ${wait(f.retryAfterSeconds)}`, canRetry: true };
    case "github_rate_limited":
      return { title: "GitHub is rate limiting this server", detail: "The server has used its allowance of GitHub requests for now. Try again later.", canRetry: true };
    case "no_provider":
      return { title: "No language model is configured", detail: "This server cannot answer questions until its operator sets a model. Indexing and source inspection still work.", canRetry: false };
    case "model_cooldown":
      return { title: "The model is rate limited right now", detail: `The language model's usage limit was reached, so questions are paused until it accepts them again. ${wait(f.retryAfterSeconds)}`, canRetry: true };
    case "network":
      return { title: "Could not reach the server", detail: "Check your connection and try again.", canRetry: true };
    case "aborted":
      return { title: "Cancelled", detail: "The request was cancelled.", canRetry: true };
    case "server":
      return { title: "Something went wrong on the server", detail: "The error was logged. Try again; if it keeps happening, the server needs attention.", canRetry: true };
  }
}
