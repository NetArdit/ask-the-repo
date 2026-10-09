import { identifierTerms, type StemMode } from "../index/tokenize";

/** Words that shape a question but say nothing about the code. Applied to queries only. */
const QUESTION_WORDS = new Set([
  "where", "what", "how", "which", "who", "why", "does", "do", "did", "is", "are", "was", "were", "the", "this", "that", "these",
  "those", "a", "an", "of", "in", "on", "for", "to", "and", "or", "it", "its", "i", "me", "my", "we", "can", "could", "should",
  "would", "there", "here", "with", "from", "by", "at", "as", "be", "been", "being", "about", "any", "some", "all", "get", "gets",
  "show", "find", "tell", "explain", "implemented", "implementation", "implement", "defined", "defines", "define", "handled",
  "handles", "handle", "happen", "happens", "file", "files", "code", "function", "functions", "module", "modules", "used", "uses",
  "use", "using", "work", "works", "when", "then", "after", "before", "called", "calls", "call", "support", "supports",
  "responsible",
]);

export interface AnalyzedQuery {
  /** Distinct stemmed search terms, in question order. */
  terms: string[];
  /** Identifier-looking tokens, lowercased, for exact symbol-name matching. */
  identifiers: string[];
}

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g;

function looksLikeIdentifier(token: string, quoted: boolean): boolean {
  return quoted || token.includes("_") || token.includes(".") || /[a-z][A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token);
}

/** Deterministic identifier/keyword extraction; no model involved. */
export function analyzeQuestion(question: string, mode: StemMode = "plural"): AnalyzedQuery {
  const quoted = new Set<string>();
  for (const m of question.matchAll(/`([^`]+)`|"([^"]+)"|([A-Za-z_$][\w$]*)\(\)/g)) {
    const inner = m[1] ?? m[2] ?? m[3];
    if (inner) quoted.add(inner.trim());
  }

  const terms = new Set<string>();
  const identifiers = new Set<string>();
  for (const match of question.matchAll(TOKEN_RE)) {
    const token = match[0];
    const lower = token.toLowerCase();
    const isQuoted = quoted.has(token);
    if (!isQuoted && QUESTION_WORDS.has(lower)) continue;
    if (looksLikeIdentifier(token, isQuoted)) {
      identifiers.add(lower);
      for (const part of token.split(".")) identifiers.add(part.toLowerCase());
    }
    for (const part of token.split(".")) {
      for (const t of identifierTerms(part, mode)) if (!QUESTION_WORDS.has(t)) terms.add(t);
    }
  }
  return { terms: [...terms], identifiers: [...identifiers] };
}
