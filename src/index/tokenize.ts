const CODE_STOPWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "import", "export", "from", "default", "new", "this", "typeof", "await",
  "async", "class", "extends", "true", "false", "null", "undefined", "of", "in", "for", "while", "try", "catch", "throw", "switch",
  "case", "break", "continue", "void", "interface", "type", "implements", "public", "private", "protected", "readonly", "static",
  "as", "is", "do", "yield", "delete", "instanceof",
]);

const ENGLISH_STOPWORDS = new Set([
  "the", "an", "and", "or", "to", "it", "its", "be", "by", "on", "at", "with", "that", "are", "was", "not", "no", "but", "so", "if",
  "we", "you", "can", "will", "has", "have", "had", "any", "all", "may", "also", "than", "then", "when", "which", "who", "into", "out",
]);

const MAX_TERM_LENGTH = 40;

/**
 * plural       — plural folding only (the Phase 1 behaviour)
 * plural+verb  — additionally folds "-ing" and "-ed" verb forms
 * Whichever mode is used at index time must be used at query time; the artifact records it.
 */
export type StemMode = "plural" | "plural+verb";

function foldPlural(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("sses")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss") && !term.endsWith("us") && !term.endsWith("is")) return term.slice(0, -1);
  return term;
}

function foldVerb(term: string): string {
  for (const suffix of ["ing", "ed"]) {
    if (!term.endsWith(suffix)) continue;
    let base = term.slice(0, -suffix.length);
    if (base.length < 4) return term;
    // "running" -> "runn" -> "run"
    if (/([^aeiou])\1$/.test(base) && !/(ss|ll|ff)$/.test(base)) base = base.slice(0, -1);
    return base;
  }
  return term;
}

export function stem(term: string, mode: StemMode = "plural"): string {
  const folded = foldPlural(term);
  return mode === "plural+verb" ? foldVerb(folded) : folded;
}

/** `parseHTTPRequest_v2` -> ["parse", "http", "request", "v2"] */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function keep(term: string): boolean {
  return term.length >= 2 && term.length <= MAX_TERM_LENGTH && !CODE_STOPWORDS.has(term) && !ENGLISH_STOPWORDS.has(term);
}

/** Terms for one identifier: the whole lowercased identifier plus its sub-words. */
export function identifierTerms(id: string, mode: StemMode = "plural"): string[] {
  const parts = splitIdentifier(id);
  const out: string[] = [];
  if (parts.length > 1) out.push(stem(id.toLowerCase().replace(/[^a-z0-9]/g, ""), mode));
  for (const p of parts) out.push(stem(p, mode));
  return out.filter(keep);
}

/** Indexing-time tokenizer: term -> frequency over a block of source text. */
export function termFrequencies(text: string, mode: StemMode = "plural"): Map<string, number> {
  const tf = new Map<string, number>();
  for (const match of text.matchAll(IDENTIFIER_RE)) {
    for (const term of identifierTerms(match[0], mode)) tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  return tf;
}

export function pathTerms(filePath: string, mode: StemMode = "plural"): string[] {
  const out: string[] = [];
  for (const seg of filePath.split("/")) {
    const base = seg.replace(/\.[A-Za-z0-9]+$/, "");
    for (const t of splitIdentifier(base)) {
      const s = stem(t, mode);
      if (s.length >= 2) out.push(s);
    }
  }
  return out;
}
