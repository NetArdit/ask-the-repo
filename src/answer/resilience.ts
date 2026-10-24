import { randomBytes } from "node:crypto";
import type { ModelProvider } from "./provider";
import type { EvidenceItem, ModelClaim, ModelOutput } from "./types";
import { quoteIsVerbatim } from "./validate";

/**
 * Things the web application does so that one slip by the model, or a question in another language, does not end in a refusal.
 * None of them weakens a check: a quote that reaches the reader still occurs word for word in the lines it cites, because
 * every repaired quote is made of text copied from those lines and is then checked exactly like any other.
 */

const MIN_PIECE_CHARS = 12;

/** Markers a model puts where it left something out of a quote. */
const ELLIPSIS = /\s*(?:\(\.\.\.\)|\[\.\.\.\]|\[…\]|\(…\)|\.{3,}|…)\s*/;

/**
 * A quote that is not word for word in its block usually has the right passage but stitches two together, or leaves a gap marked
 * "...". The longest piece of it that is word for word in the block (a part between gaps, or one line) is used instead.
 * Returns null when no piece is long enough to mean anything.
 */
export function bestVerbatimPiece(quote: string, item: EvidenceItem): string | null {
  const lines = quote.split("\n").map((l) => l.replace(/^L\d+\|\s?/, ""));
  const pieces = new Set<string>();
  for (const part of lines.join("\n").split(ELLIPSIS)) {
    const p = part.trim();
    if (p) pieces.add(p);
  }
  for (const line of lines) {
    const p = line.trim();
    if (p) pieces.add(p);
  }
  let best: string | null = null;
  for (const p of pieces) {
    if (p.length < MIN_PIECE_CHARS || !quoteIsVerbatim(p, item)) continue;
    if (best === null || p.length > best.length) best = p;
  }
  return best;
}

export interface QuoteRepair {
  output: ModelOutput;
  /** How many quotes were cut down to the part that is word for word in the cited lines. */
  repaired: number;
}

/** Replaces each quote that is not word for word in its block by its best verbatim piece, when there is one. */
export function repairQuotes(output: ModelOutput, items: readonly EvidenceItem[]): QuoteRepair {
  if (output.status !== "answered") return { output, repaired: 0 };
  const byId = new Map(items.map((i) => [i.id, i] as const));
  let repaired = 0;
  const claims: ModelClaim[] = output.claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((e) => {
      const item = byId.get(e.citation);
      if (!item || quoteIsVerbatim(e.quote, item)) return e;
      const piece = bestVerbatimPiece(e.quote, item);
      if (piece === null) return e;
      repaired += 1;
      return { ...e, quote: piece };
    }),
  }));
  return { output: { ...output, claims }, repaired };
}

/** The sentence added to the model's input for its one second try. Built from the application's own reasons, never from the reply. */
export function repairInstruction(nonce: string, problems: string[]): string {
  const listed = problems.slice(0, 6).join("; ");
  return `@@${nonce} REPAIR your previous reply failed these checks: ${listed}. Reply again with one complete JSON object. Copy every quote exactly from one place in the block it names, never with "..."; leave out any claim you cannot quote exactly, and keep the reply to at most 6 claims.`;
}

const ENGLISH_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on", "for", "and", "or", "it", "its", "this", "that", "what", "where", "how", "why", "which", "who",
  "does", "do", "did", "can", "could", "should", "would", "with", "from", "by", "at", "as", "code", "file", "function", "page", "button", "work", "works", "i", "me", "my",
  "show", "find", "explain", "there", "here", "when", "then", "about", "project", "app", "use", "uses", "used", "call", "calls", "handle", "handled", "implemented",
]);

/**
 * Function words and common programming words of other languages that are not also English words, so that one of them in a
 * question marks it as not (only) English, even when typed without accents and mixed with English technical terms
 * ("ku e ben login dhe createSession"). Albanian first; then German, Spanish, French, Italian, Portuguese, Turkish.
 */
const FOREIGN_WORDS = new Set([
  // Albanian
  "ku", "kush", "pse", "cfare", "eshte", "jane", "dhe", "ose", "ky", "kjo", "këtë", "kete", "funksionon", "funksionojne", "ben", "bejne", "kodi", "kodin", "faqja", "faqen", "faqes",
  "skedari", "skedarin", "projekti", "projektin", "perdoruesi", "perdoruesit", "ruan", "ruaj", "krijon", "hyrje", "hyn", "dil", "shfaq", "shfaqet", "tregon", "thirret", "ngarkon", "shpjego", "tregomë",
  "tregome", "pershkruaj", "gjithcka", "punon", "punojne", "kontrollon", "kontrollohet", "verifikon", "krijohet", "ruhet", "fshin", "cila", "cili", "cilat", "cilin", "ndryshon", "perdor", "perdoret",
  "thote", "bën", "ngarkohet", "dergon", "merr", "kthen", "lidhet", "lidh", "hap", "mbyll", "gabim", "gabimet", "gjitha", "sistemi", "aplikacioni", "butoni", "butonin", "nuk", "po", "mund", "duhet", "ketu", "atje", "pastaj", "kur", "si",
  // German
  "wo", "wie", "wird", "werden", "nicht", "und", "der", "die", "das", "ein", "eine", "mit", "dieses", "diese", "funktioniert", "welche", "warum",
  // Spanish
  "donde", "dónde", "qué", "esta", "este", "hace", "funciona", "los", "las", "una", "para", "porque", "cómo", "proyecto",
  // French
  "où", "comment", "les", "une", "dans", "pour", "fait", "fonctionne", "cette", "projet", "quel", "quelle",
  // Italian
  "dove", "cosa", "questo", "questa", "funziona", "nel", "della", "perché", "progetto",
  // Portuguese, Turkish
  "onde", "isto", "não", "nasıl", "nerede", "bu", "ve", "için", "proje",
]);

/**
 * Whether a question is probably not (only) in English, so some of its words will not match the English names in code.
 * Deterministic. It is true for a question that is wholly in another language and for one that mixes languages. A false
 * "yes" costs one small extra model call; a false "no" leaves the question as it was.
 */
export function looksNonEnglish(question: string): boolean {
  const words = question.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return false;
  if (/[À-ɏͰ-ϿЀ-ӿ֐-ۿ぀-ヿ一-鿿가-힯]/u.test(question)) return true;
  if (words.some((w) => FOREIGN_WORDS.has(w))) return true;
  const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  return words.length >= 3 && english / words.length < 0.2;
}

const KEYWORD_SYSTEM = `You help search a source-code repository. Given a question in any language, reply with one JSON object and nothing else: {"keywords":["..."]}. List up to 10 lowercase English words or identifiers that code answering the question is likely to contain (names of functions, files, routes, UI labels, technologies). No sentences, no explanations.`;

const KEYWORD_RE = /^[a-z][a-z0-9_.-]{1,30}$/;

/** Reads the keyword reply strictly: only short lowercase identifier-like strings survive, at most ten. Anything else gives none. */
export function parseKeywords(raw: string): string[] {
  try {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a === -1 || b <= a) return [];
    const value = (JSON.parse(raw.slice(a, b + 1)) as { keywords?: unknown }).keywords;
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const k of value) {
      if (typeof k !== "string") continue;
      const w = k.trim().toLowerCase();
      if (KEYWORD_RE.test(w) && !out.includes(w)) out.push(w);
      if (out.length >= 10) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** One small model call that turns a question in another language into English search words. Any failure gives none. */
export async function englishKeywords(provider: ModelProvider, question: string, signal: AbortSignal): Promise<string[]> {
  try {
    const nonce = randomBytes(8).toString("hex");
    const raw = await provider.complete({ system: KEYWORD_SYSTEM, user: `Question:\n${question.slice(0, 400)}`, maxTokens: 120, nonce }, signal);
    return parseKeywords(raw);
  } catch {
    return [];
  }
}
