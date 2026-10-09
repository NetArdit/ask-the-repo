import type { CitationLocator, CitationVerdict, ClaimVerdict, EvidenceItem, ModelClaim, ModelEvidence, ModelOutput, Rejection, ValidatedAnswer } from "./types";

/**
 * Version of the evidence contract this validator enforces. Results produced under different versions are not comparable.
 *   1: a claim listed evidence ids and gave one optional quote, accepted if it occurred in any of the cited blocks.
 *   2: every evidence entry is one id with its own quote, and the quote must occur in that block and no other. A quote over
 *      400 characters makes the whole reply malformed.
 *   3: as 2, except for length. A quote over 400 characters is checked like any other (verbatim, one continuous passage, in
 *      the block its entry names) and, once checked in full, is kept and shown cut to its first 400 characters, marked as
 *      trimmed. Under contract 2 every run lost two or three whole answers to real code quoted at length; the limit bounds
 *      what is stored and displayed and was never a sign that a claim is unsupported. A quote over 4,000 characters is still
 *      malformed, so a reply cannot make the validator do unbounded work.
 *
 * EVIDENCE_CONTRACT is the latest, which new evaluation runs use and name their files by, and which the web application asks for
 * (answer/defaults.ts). DEFAULT_EVIDENCE_CONTRACT is what `parseModelOutput` and the pipeline assume when told nothing: the
 * contract every stored reply was first recorded under, so that a caller has to ask for the newer rule to get it.
 */
export type EvidenceContract = 2 | 3;
export const EVIDENCE_CONTRACT: EvidenceContract = 3;
export const DEFAULT_EVIDENCE_CONTRACT: EvidenceContract = 2;

export const MAX_CLAIMS = 8;
export const MAX_CLAIM_CHARS = 600;
export const MAX_CITATIONS_PER_CLAIM = 6;
/** The most of a quote that is stored, returned or shown. Under contract 2 also the most a quote may be. */
export const MAX_QUOTE_CHARS = 400;
/** Contract 3: the most a quote may be before it is refused unread. */
export const MAX_RAW_QUOTE_CHARS = 4000;
const MAX_ID_CHARS = 40;

export type ParseResult = { ok: true; output: ModelOutput } | { ok: false; reason: string; code?: "quote-too-long" };

function extractJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced ? fenced[1]! : text;
  try {
    return JSON.parse(body);
  } catch {
    // Models sometimes add a sentence around the object; accept the outermost braces and nothing looser.
    const a = body.indexOf("{");
    const b = body.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("no JSON object");
    return JSON.parse(body.slice(a, b + 1));
  }
}

function parseUnsupported(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || !value.every((x) => typeof x === "string" && x.length <= 300)) return null;
  return value as string[];
}

const quoteLimit = (contract: EvidenceContract) => (contract === 2 ? MAX_QUOTE_CHARS : MAX_RAW_QUOTE_CHARS);
const quoteTooLong = (contract: EvidenceContract) => `an evidence quote is longer than ${quoteLimit(contract)} characters`;
const BAD_EVIDENCE_ENTRY = "each evidence entry needs one citation id and its own quote";

/** One evidence entry: exactly one id and the quote that belongs to it. Anything else is malformed, and says why. */
function parseEvidence(value: unknown, contract: EvidenceContract): ModelEvidence | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return BAD_EVIDENCE_ENTRY;
  const { citation, quote } = value as Record<string, unknown>;
  if (typeof citation !== "string" || citation.trim() === "" || citation.length > MAX_ID_CHARS) return BAD_EVIDENCE_ENTRY;
  if (typeof quote !== "string" || quote.trim() === "") return BAD_EVIDENCE_ENTRY;
  // A real but over-long quote is a different failure from a missing one, and the two should not look alike in diagnostics.
  if (quote.length > quoteLimit(contract)) return quoteTooLong(contract);
  return { citation, quote };
}

/**
 * Strict shape check of the model's reply. Anything that does not match the schema is rejected, never repaired.
 * `contract` decides only how long a quote may be (see EVIDENCE_CONTRACT); told nothing, it is the application's contract.
 */
export function parseModelOutput(raw: string, contract: EvidenceContract = DEFAULT_EVIDENCE_CONTRACT): ParseResult {
  const QUOTE_TOO_LONG = quoteTooLong(contract);
  let value: unknown;
  try {
    value = extractJson(raw);
  } catch {
    return { ok: false, reason: "output is not a JSON object" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "output is not a JSON object" };
  const o = value as Record<string, unknown>;
  if (o.status === "insufficient_evidence") {
    if (o.missing !== undefined && typeof o.missing !== "string") return { ok: false, reason: "missing must be a string" };
    const unsupported = parseUnsupported(o.unsupported);
    if (unsupported === null) return { ok: false, reason: "unsupported must be an array of short strings" };
    return { ok: true, output: { status: "insufficient_evidence", missing: typeof o.missing === "string" ? o.missing.slice(0, 500) : undefined, ...(unsupported.length ? { unsupported } : {}) } };
  }
  if (o.status !== "answered") return { ok: false, reason: "status must be answered or insufficient_evidence" };
  if (!Array.isArray(o.claims) || o.claims.length === 0 || o.claims.length > MAX_CLAIMS) return { ok: false, reason: `claims must be an array of 1..${MAX_CLAIMS}` };
  const claims: ModelClaim[] = [];
  for (const c of o.claims) {
    if (!c || typeof c !== "object") return { ok: false, reason: "claim is not an object" };
    const { text, evidence } = c as Record<string, unknown>;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_CLAIM_CHARS) return { ok: false, reason: "claim text missing or too long" };
    // A reply in the older shape (a list of ids and one loose quote) has no `evidence` list and fails here, closed.
    if (!Array.isArray(evidence) || evidence.length > MAX_CITATIONS_PER_CLAIM) return { ok: false, reason: "claim evidence must be a list of {citation, quote}" };
    const entries: ModelEvidence[] = [];
    for (const e of evidence) {
      const entry = parseEvidence(e, contract);
      if (typeof entry === "string") return entry === QUOTE_TOO_LONG ? { ok: false, reason: entry, code: "quote-too-long" } : { ok: false, reason: entry };
      entries.push(entry);
    }
    claims.push({ text, evidence: entries });
  }
  const unsupported = parseUnsupported(o.unsupported);
  if (unsupported === null) return { ok: false, reason: "unsupported must be an array of short strings" };
  return { ok: true, output: { status: "answered", claims, ...(unsupported.length ? { unsupported } : {}) } };
}

export class EvidenceRegistry {
  private readonly byId = new Map<string, EvidenceItem>();
  constructor(
    readonly items: readonly EvidenceItem[],
    private readonly expected: { owner: string; repo: string; sha: string },
  ) {
    for (const i of items) this.byId.set(i.id, i);
  }

  get(id: string): EvidenceItem | undefined {
    return this.byId.get(id);
  }

  /** Checks a citation against the evidence the application supplied. Every field the citation carries must agree. */
  check(c: CitationLocator): CitationVerdict {
    const item = this.byId.get(c.id);
    if (!item) return { valid: false, reason: "unknown-evidence-id" };
    if (c.owner !== undefined && c.owner !== this.expected.owner) return { valid: false, reason: "wrong-repository" };
    if (c.repo !== undefined && c.repo !== this.expected.repo) return { valid: false, reason: "wrong-repository" };
    if (item.repo.owner !== this.expected.owner || item.repo.repo !== this.expected.repo) return { valid: false, reason: "wrong-repository" };
    if ((c.sha !== undefined && c.sha !== this.expected.sha) || item.repo.sha !== this.expected.sha) return { valid: false, reason: "wrong-sha" };
    if (c.path !== undefined && c.path !== item.path) return { valid: false, reason: "wrong-path" };
    const hasLines = c.startLine !== undefined || c.endLine !== undefined;
    if (hasLines) {
      const a = c.startLine ?? c.endLine!;
      const b = c.endLine ?? c.startLine!;
      if (![a, b].every((n) => Number.isInteger(n) && n >= 1)) return { valid: false, reason: "invalid-line-number" };
      if (a > b) return { valid: false, reason: "reversed-range" };
      if (b > item.fileLineCount) return { valid: false, reason: "range-beyond-file" };
      if (a < item.startLine || b > item.endLine) return { valid: false, reason: "outside-evidence-range" };
    }
    return { valid: true };
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * A quote is verbatim in an evidence item if, ignoring runs of whitespace and any "L12|" prefixes, it occurs in that item's
 * text as one continuous passage. It is checked against the one item its entry names: a quote that is real but comes from a
 * different block, or that stitches two places together, does not pass.
 */
export function quoteIsVerbatim(quote: string, item: EvidenceItem): boolean {
  const q = normalize(quote.split("\n").map((l) => l.replace(/^L\d+\|\s?/, "")).join(" "));
  if (q.length < 3) return false;
  return normalize(item.text).includes(q);
}

/** The first MAX_QUOTE_CHARS characters of a long quote, ending at a line end when there is one to end at. */
export function trimQuote(quote: string): string {
  if (quote.length <= MAX_QUOTE_CHARS) return quote;
  const head = quote.slice(0, MAX_QUOTE_CHARS);
  const lineEnd = head.lastIndexOf("\n");
  return lineEnd > 0 ? head.slice(0, lineEnd) : head;
}

export interface ValidationOptions {
  /** Reject an answer that contains a claim with no evidence. Default true: every claim must be traceable. */
  requireCitations?: boolean;
  /** Reject an answer in which a quote is not verbatim in the evidence its entry names. Default true. */
  requireVerbatimQuotes?: boolean;
}

/**
 * Deterministic, structural validation of a model answer: every evidence id is one the application supplied, and every quote
 * occurs in the block it is attributed to. It does NOT check that the quoted code supports the claim. That is semantic
 * support, which this function cannot see and never reports.
 */
export function validateAnswer(output: ModelOutput, registry: EvidenceRegistry, options: ValidationOptions = {}): ValidatedAnswer {
  if (output.status === "insufficient_evidence") return { status: "insufficient_evidence", claims: [], reasons: [], rejections: [], missing: output.missing, unsupported: output.unsupported };
  const requireCitations = options.requireCitations ?? true;
  const requireQuotes = options.requireVerbatimQuotes ?? true;
  const claims: ClaimVerdict[] = [];
  const reasons: string[] = [];
  const rejections: Rejection[] = [];
  output.claims.forEach((claim, i) => {
    const n = i + 1;
    const citations = claim.evidence.map((e) => {
      const verdict = registry.check({ id: e.citation });
      const item = verdict.valid ? registry.get(e.citation) : undefined;
      // The whole quote is checked first. Only then is a long one cut for keeping: a quote over the limit reaches this point
      // under contract 3 alone, and what is stored is an excerpt for display, never the basis of the check.
      const quoteVerbatim = item !== undefined && quoteIsVerbatim(e.quote, item);
      const long = e.quote.length > MAX_QUOTE_CHARS;
      return { id: e.citation, verdict, quote: long ? trimQuote(e.quote) : e.quote, quoteVerbatim, ...(long ? { quoteTrimmed: true as const } : {}) };
    });
    const invalid = citations.filter((c) => !c.verdict.valid);
    const misquoted = citations.filter((c) => c.verdict.valid && !c.quoteVerbatim);
    let status: ClaimVerdict["status"] = "cited";
    if (citations.length === 0) status = "uncited";
    else if (invalid.length > 0) status = "invalid-citation";
    else if (misquoted.length > 0) status = "quote-mismatch";
    claims.push({ text: claim.text, citations, quoteVerbatim: citations.length === 0 ? null : citations.every((c) => c.quoteVerbatim), status });

    if (status === "invalid-citation") {
      reasons.push(`claim ${n} has invalid citations (${invalid.map((c) => `${c.id}:${(c.verdict as { reason: string }).reason}`).join(", ")})`);
      for (const c of invalid) rejections.push({ code: "invalid-citation", claim: n, citation: c.id, detail: (c.verdict as { reason: string }).reason });
    } else if (status === "uncited" && requireCitations) {
      reasons.push(`claim ${n} has no citation`);
      rejections.push({ code: "uncited-claim", claim: n });
    } else if (status === "quote-mismatch" && requireQuotes) {
      reasons.push(`claim ${n} quote is not in the cited evidence (${misquoted.map((c) => c.id).join(", ")})`);
      for (const c of misquoted) rejections.push({ code: "quote-not-in-citation", claim: n, citation: c.id });
    }
  });
  return { status: reasons.length > 0 ? "rejected" : "answered", claims, reasons, rejections, unsupported: output.unsupported };
}
