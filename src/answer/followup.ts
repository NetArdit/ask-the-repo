// W-11 follow-up context (QUALITY-NEWCOMER section 5.1, option A). Pure functions: no provider, no file system, no network, no model call.
// The previous turn (sent by the client) is hostile input. It is used only as search words and as file hints; nothing in it reaches the
// model prompt, and the blocks it points to are index blocks that are verified against the commit like any other.
import type { StemMode } from "../index/tokenize";
import type { LoadedIndex } from "../retrieve/loaded-index";
import { analyzeQuestion } from "../retrieve/query";

/** Words a newcomer uses to describe themselves or to ask for a gentler tone. They say nothing about the code and only dilute the coverage score. */
export const FILLER_BEGINNER: ReadonlySet<string> = new Set([
  "am", "dont", "don", "doesn", "didn", "isn", "aren", "wasn", "know", "knew", "understand", "understood", "anything", "everything",
  "programming", "programmer", "coding", "coder", "beginner", "newbie", "novice", "noob", "learn", "learning", "teach", "basic", "basics",
  "simple", "simply", "plain", "easy", "easily", "words", "word", "please", "pls", "thanks", "thank", "hello", "hey", "sorry", "confused",
  "confusing", "clue", "idea", "really", "very", "just", "every", "live", "lives", "exaplain", "explian", "explane", "explaine", "kindly",
  "newcomer", "mean", "means", "meaning", "question", "questions", "need", "needs", "something", "someone", "somebody",
]);

/** Teaching requests that name no topic ("explain every step simply"). Removed whole, only with the beginner filler. */
const BEGINNER_PHRASES = new RegExp(
  [
    "step by step", "(?:every|each) steps?", "all the steps",
    // Words that name the kind of answer wanted, not a topic: "for which kinds of requests", "what sort of errors" (the head noun stays).
    "(?:kinds?|sorts?) of",
    // A register request: "in simple terms", "in plain english", "in layman's words".
    "(?:in )?(?:simple|plain|easy|everyday|layman'?s?) (?:terms|english|language|words)",
    // An all-purpose "rest" ("the rest of the app") names no part of the code.
    "the rest of the",
  ].map((p) => `\\b${p}\\b`).join("|"),
  "gi",
);

/**
 * Beginner wording that names a concept with everyday words the code does not use. Each rule matches a whole PHRASE (never a single
 * ambiguous word such as "page", "again", "tell" or "test") and adds fixed technical words to the search text. The question's own words
 * stay, so ranking only gains terms; nothing from the question is copied into the output, and every pattern is bounded.
 */
const GLOSSARY: readonly { phrase: RegExp; add: string }[] = [
  // "try again", "tries again", "trying again", "attempt it again", "keeps trying" -> retry
  { phrase: /\b(?:tr(?:y|ies|ied|ying)|attempt(?:s|ed|ing)?)\s+(?:\w+\s+){0,2}again\b|\bkeeps?\s+trying\b/i, add: "retry" },
  // "kinds / types / sorts of requests" -> the method of a request
  { phrase: /\b(?:kinds?|types?|sorts?)\s+of\s+(?:\w+\s+)?(?:requests?|calls?)\b/i, add: "method" },
  // "not found", "cannot be found" -> the status code 404
  { phrase: /\b(?:not\s+found|(?:can(?:'|no)?t|cannot|could\s*n'?t|won'?t)\s+be\s+found)\b/i, add: "404" },
  // "tell/let/inform/alert ... that something changed" -> listeners are notified
  { phrase: /\b(?:tells?|telling|let(?:s|ting)?|informs?|informing|alerts?|alerting|notif(?:y|ies|ying))\b[^.?!]{0,50}?\b(?:changed?|changes|updated?|updates|modified)\b/i, add: "notify listener subscribe" },
  // "run / execute the tests" -> the test suite (the word "tests" alone stays ambiguous and is not mapped)
  { phrase: /\b(?:run(?:ning|s)?|execut(?:e|es|ing))\s+(?:all\s+)?(?:the\s+|its\s+|these\s+)?(?:\w+\s+)?tests\b/i, add: "test suite" },
];

/** Technical words implied by everyday phrasing in `question`, to be appended to the search text. Empty when no phrase matches. */
export function glossaryTerms(question: string): string {
  const text = question.length > 2000 ? question.slice(0, 2000) : question;
  return GLOSSARY.filter((g) => g.phrase.test(text)).map((g) => g.add).join(" ");
}

/** Words that point back to the previous turn instead of naming a topic. They carry no topic of their own. */
export const FILLER_REFERENCE: ReadonlySet<string> = new Set([
  "it", "its", "they", "them", "their", "that", "those", "these", "there", "other", "another", "one", "ones", "same", "more", "again", "also",
  "too", "else", "then", "above", "earlier", "previous", "thing", "things", "stuff", "something", "example", "examples", "give", "show",
  "ok", "okay", "yes", "yeah", "need", "needs", "needed", "necessary",
]);

/** The reference words that, together with at most two informative terms, mark a question as pointing back. */
const POINTS_BACK = /\b(it|its|that|those|these|there|they|them)\b/i;

/** Words that make a question without any topic word a follow-up. */
const POINTERS = /\b(it|its|that|this|those|these|there|they|them|their|more|other|another|one|ones|same|again|above|earlier|previous|example|examples)\b/i;

const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g;

/** Removes the plain words found in any of `sets`. A word that looks like a code identifier, or sits in backticks or quotes, or is called like `x()`, is never removed. */
function stripFiller(text: string, sets: readonly ReadonlySet<string>[]): string {
  return (sets.includes(FILLER_BEGINNER) ? text.replace(BEGINNER_PHRASES, " ") : text)
    .replace(WORD_RE, (token, offset: number, whole: string) => {
      if (token.includes(".") || token.includes("_") || token.includes("$") || /[a-z][A-Z]/.test(token)) return token;
      const lower = token.toLowerCase();
      if (!sets.some((s) => s.has(lower))) return token;
      const before = whole[offset - 1];
      const after = whole[offset + token.length];
      if (before === "`" || before === '"' || after === "(" || after === "`" || after === '"') return token;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The question's search terms that carry a topic: not a question word, not filler, and (when `known` is given) present in the repository's index. */
export function informativeTerms(question: string, mode: StemMode = "plural", known?: (term: string) => boolean): string[] {
  const terms = analyzeQuestion(stripFiller(question, [FILLER_BEGINNER, FILLER_REFERENCE]), mode).terms;
  return known ? terms.filter(known) : terms;
}

export interface FollowUpContext {
  /** The repository's name. A question that contains it names a topic of its own. */
  repo?: string;
  mode?: StemMode;
  known?: (term: string) => boolean;
}

/**
 * True when the question depends on the previous turn: at most one informative term, or two together with a pointing word ("it", "those"...).
 * Never true for a question that contains the repository name or a code-like identifier: that is a new topic.
 */
export function isFollowUp(question: string, context: FollowUpContext = {}): boolean {
  const mode = context.mode ?? "plural";
  if (analyzeQuestion(question, mode).identifiers.length > 0) return false;
  const repo = (context.repo ?? "").trim().toLowerCase();
  if (repo !== "" && question.toLowerCase().includes(repo)) return false;
  const n = informativeTerms(question, mode, context.known).length;
  // With no topic word at all the question must also say that it points somewhere ("it", "more", "the other one"): "weather in Tirana" has no topic word the index knows, but it points at nothing.
  if (n === 0) return POINTERS.test(question);
  return n === 1 || (n === 2 && POINTS_BACK.test(question));
}

/**
 * The text the search runs on. Beginner filler is always dropped. With `inheritFrom` (the previous question of an answered turn) the
 * pointing words are dropped too and the previous question's words are appended: a plain string of words, never an instruction.
 */
export function searchTextFor(question: string, inheritFrom?: string): string {
  const extra = glossaryTerms(question);
  if (inheritFrom === undefined) return `${stripFiller(question, [FILLER_BEGINNER])} ${extra}`.trim();
  const own = stripFiller(question, [FILLER_BEGINNER, FILLER_REFERENCE]);
  const inherited = stripFiller(inheritFrom, [FILLER_BEGINNER, FILLER_REFERENCE]);
  return `${own} ${extra} ${inherited}`.replace(/\s+/g, " ").trim();
}

export interface PreviousFile {
  path: string;
  startLine: number;
  endLine: number;
}

/** The last turn as the server accepts it. `files` come from the evidence the previous answer cited. */
export interface Previous {
  question: string;
  outcome: "answered" | "refused";
  files: PreviousFile[];
}

export const MAX_PREVIOUS_QUESTION = 300;
export const MAX_PREVIOUS_FILES = 5;
export const MAX_PREVIOUS_PATH = 200;
/** Blocks of the previous files that are moved to the front of the evidence candidates for one turn. */
export const MAX_INHERITED_BLOCKS = 6;
const MAX_LINE = 10_000_000;

function cleanQuestion(text: string): string {
  let s = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > MAX_PREVIOUS_QUESTION) s = s.slice(0, MAX_PREVIOUS_QUESTION);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s.trim();
}

function validFile(raw: unknown): PreviousFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { path, startLine, endLine } = raw as Record<string, unknown>;
  if (typeof path !== "string" || typeof startLine !== "number" || typeof endLine !== "number") return null;
  if (path === "" || path.length > MAX_PREVIOUS_PATH || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > MAX_LINE) return null;
  return { path, startLine, endLine };
}

/** Anything that is not exactly the documented shape is ignored (null), never an error, so a stale or hostile client cannot break a request. */
export function validatePrevious(raw: unknown): Previous | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { question, outcome, files } = raw as Record<string, unknown>;
  if (typeof question !== "string" || (outcome !== "answered" && outcome !== "refused")) return null;
  const q = cleanQuestion(question);
  if (q === "") return null;
  const kept: PreviousFile[] = [];
  if (Array.isArray(files)) {
    for (const f of files) {
      if (kept.length >= MAX_PREVIOUS_FILES) break;
      const ok = validFile(f);
      if (ok) kept.push(ok);
    }
  }
  return { question: q, outcome, files: kept };
}

/** An answered previous turn with a question: the only kind a follow-up inherits from. */
export function isUsablePrevious(previous: Previous | null | undefined): previous is Previous {
  return previous != null && previous.outcome === "answered" && previous.question !== "";
}

export interface InheritedBlock {
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
}

/**
 * Index blocks that overlap the lines of the previous files, at most six. Path, lines and ids are read from the index, never copied from the
 * client: a path the index does not know yields nothing. The blocks are verified against the commit later, like every candidate.
 */
export function previousBlocks(index: LoadedIndex, files: readonly PreviousFile[], max: number = MAX_INHERITED_BLOCKS): InheritedBlock[] {
  const byPath = new Map<string, number>();
  index.artifact.files.forEach((f, i) => byPath.set(f[0], i));
  const out: InheritedBlock[] = [];
  const taken = new Set<number>();
  for (const f of files) {
    const fileIdx = byPath.get(f.path);
    if (fileIdx === undefined) continue;
    const file = index.artifact.files[fileIdx]!;
    for (let c = file[5]; c < file[5] + file[6]; c++) {
      if (out.length >= max) return out;
      const chunk = index.artifact.chunks[c]!;
      if (taken.has(c) || chunk[1] > f.endLine || chunk[2] < f.startLine) continue;
      taken.add(c);
      out.push({ chunkId: c, path: file[0], startLine: chunk[1], endLine: chunk[2], score: 0 });
    }
  }
  return out;
}
