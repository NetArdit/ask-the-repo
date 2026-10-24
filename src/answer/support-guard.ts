/**
 * Lexical claim-to-evidence guard (P-001a). Pure, deterministic, no imports, no model call, no network.
 *
 * It asks one narrow question: does the quote a claim cites share enough distinctive vocabulary with the claim? A claim that
 * shares almost none of its words with its own quote is probably not what that quote shows, and is marked `weak`.
 *
 * LIMITATION, stated plainly: lexical matching cannot see negation, paraphrase or semantic contradiction. "X never aborts" and
 * "X aborts" share the same words; a correct paraphrase in other words looks weak; a false claim stuffed with identifiers
 * copied from the quote looks strong. `weak: false` therefore means "not obviously unrelated", never "supported". The result is
 * an annotation for a reader or a later check, not a verdict on the claim.
 */

export interface LexicalSupport {
  /** true when the claim shares too little distinctive vocabulary with the quote */
  weak: boolean;
  /** shared distinctive tokens divided by the claim's distinctive tokens, 0..1 (0 when the claim has none) */
  score: number;
  /** the distinctive tokens both sides contain, sorted */
  shared: string[];
}

/** Fewest distinctive tokens a claim and its quote must share. */
export const MIN_SHARED = 2;
/** Smallest share of the claim's distinctive tokens that the quote must contain. */
export const MIN_SHARE = 0.25;
/** Shortest token kept. */
export const MIN_TOKEN_CHARS = 3;

/** English and selected Albanian function words. Identifier parts such as "get" or "set" are deliberately not listed. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "the and for are but not you all any can had her was one our out has have his how its may new now old see two way who did " +
    "that this these those with from into onto over under than then them they their there here " +
    "what when where which while will would should could also only just very more most some such each both either other " +
    "about after before because been being does done else even ever once same still too upon via per " +
    "dhe per një nje të te që qe është eshte nga me në ne se por ose edhe ka kjo ky ato ata ajo për jo si më ma do duhet " +
    "është janë jane kanë kane mund këtë kete atë ate tek pas para ndaj gjatë gjate nëse nese kur ku çfarë cfare"
  ).split(" "),
);

/** Splits camelCase, snake_case, kebab-case, dotted and slashed names and any other non-word run into lowercase words. */
function words(text: string): string[] {
  return text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The distinctive tokens of a text: lowercase words without stop words and without very short tokens. */
export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) if (w.length >= MIN_TOKEN_CHARS && !STOP_WORDS.has(w)) out.add(w);
  return out;
}

export function lexicalSupport(claim: string, quote: string): LexicalSupport {
  const claimTokens = distinctiveTokens(claim);
  const quoteTokens = distinctiveTokens(quote);
  const shared = [...claimTokens].filter((t) => quoteTokens.has(t)).sort();
  const score = claimTokens.size === 0 ? 0 : shared.length / claimTokens.size;
  return { weak: shared.length < MIN_SHARED || score < MIN_SHARE, score, shared };
}
