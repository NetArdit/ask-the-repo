export interface RepoIdentity {
  owner: string;
  repo: string;
  /** The exact commit the index was built from. */
  sha: string;
}

/** One verified span of repository source that the model may cite. */
export interface EvidenceItem {
  /** Request-local handle the model cites, e.g. "E3". Never a location. */
  id: string;
  /** Stable identity across requests: owner/repo@sha:path#Lstart-Lend */
  key: string;
  repo: RepoIdentity;
  path: string;
  startLine: number;
  endLine: number;
  /** Exact source lines, joined with "\n". Held in memory for the request; never stored in the index. */
  text: string;
  /** Fingerprint of the lines as indexed; equals the fingerprint of `text` or the item would not exist. */
  chunkHash: string;
  /** Line count of the whole file at the indexed commit. */
  fileLineCount: number;
  score: number;
  /** The text looks like an instruction aimed at a model. Informational only; never relied upon as a defence. */
  injectionSuspect: boolean;
}

/** A citation as a claim would reference it. Only `id` is required; any other field present is checked against the registry. */
export interface CitationLocator {
  id: string;
  owner?: string;
  repo?: string;
  sha?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}

export type CitationRejection =
  | "unknown-evidence-id"
  | "wrong-repository"
  | "wrong-sha"
  | "wrong-path"
  | "invalid-line-number"
  | "reversed-range"
  | "range-beyond-file"
  | "outside-evidence-range";

export type CitationVerdict = { valid: true } | { valid: false; reason: CitationRejection };

/** One piece of evidence for a claim: one evidence id and the quote taken from that block. A quote never stands apart from its id. */
export interface ModelEvidence {
  citation: string;
  quote: string;
}

export interface ModelClaim {
  text: string;
  evidence: ModelEvidence[];
}

export type ModelOutput =
  | { status: "answered"; claims: ModelClaim[]; unsupported?: string[] }
  | { status: "insufficient_evidence"; missing?: string; unsupported?: string[] };

export type ClaimStatus = "cited" | "uncited" | "invalid-citation" | "quote-mismatch";

export interface ClaimVerdict {
  text: string;
  /**
   * One entry per piece of evidence the claim gave: the id, whether that id names evidence the application supplied, the
   * quote, and whether the quote occurs verbatim in that very block. These are structural checks only.
   */
  citations: { id: string; verdict: CitationVerdict; quote: string; quoteVerbatim: boolean; /** Contract 3: the model's quote was longer than is kept; `quote` is its first part, cut after the whole was checked. */ quoteTrimmed?: true }[];
  /** true when every quote is verbatim in the block its own entry names; null when the claim gave no evidence */
  quoteVerbatim: boolean | null;
  status: ClaimStatus;
}

export type RejectionCode = "malformed-output" | "uncited-claim" | "invalid-citation" | "quote-not-in-citation" | "quote-too-long" | "provider-error";

/** Why a reply was not accepted, in a form a program can count and a person can read. */
export interface Rejection {
  code: RejectionCode;
  /** 1-based index of the claim, when the reason concerns one claim */
  claim?: number;
  /** The evidence id concerned, when there is one */
  citation?: string;
  /** A short machine detail, for example the citation check that failed or the provider failure kind. Never model or repository text. */
  detail?: string;
}

export type AnswerStatus = "answered" | "insufficient_evidence" | "rejected" | "provider_error" | "no_evidence";

export interface ValidatedAnswer {
  status: "answered" | "insufficient_evidence" | "rejected";
  claims: ClaimVerdict[];
  /** Why an answer was rejected. Empty otherwise. */
  reasons: string[];
  /** The same reasons, structured. Empty otherwise. */
  rejections: Rejection[];
  missing?: string;
  /** Things the model says the question asked about but the evidence does not show (prompt variant B). Informational. */
  unsupported?: string[];
}
