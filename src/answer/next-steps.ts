// W-13 "never a dead end" (QUALITY-NEWCOMER section 5.3), server side. Pure functions: no imports, no network, no call to any model.
// Suggestions are plain strings for buttons that fill the question box; the interface renders them as text, never as markup.

/** Which of the refusal cards of section 5.3 the interface should show. */
export type NextStepKind = "refusal" | "follow_up" | "clarify" | "closest_files";

export type NextStepSource = "previous" | "file" | "starter";

/** `label` is the button text, `question` is what the button puts in the question box. Both are plain strings of at most 120 characters. */
export interface NextStepSuggestion {
  label: string;
  question: string;
  source: NextStepSource;
}

export interface NextSteps {
  kind: NextStepKind;
  suggestions: NextStepSuggestion[];
}

export const MAX_SUGGESTIONS = 3;
export const MAX_TEXT = 120;
export const MAX_FILE_NAME = 60;
/** Files named in a suggestion: at most two, so that a starter question is still offered beside them. */
const MAX_FILE_SUGGESTIONS = 2;

/** The three starter questions. They are answered by the overview route, so they work on any indexed repository. */
export const STARTER_QUESTIONS: readonly string[] = ["What is this repository?", "How do I run it?", "How is it organized?"];

/** English copy of section 5.3 (states 1 to 4, 5 as a constant only, 7, 9 and 10). The pause and daily-limit texts (6, 8) belong to W-15 and are not here. */
export const NEXT_STEP_COPY = {
  refusal: "I could not find this in the code yet. Try a more specific question, for example:",
  followUp: (previousQuestion: string) => `This looks like a follow-up to "${cleanText(previousQuestion, MAX_TEXT)}".`,
  followUpAgain: "Ask again about that topic",
  followUpNew: "Ask something new",
  clarify: (phrase: string) => `I am not sure what "${cleanText(phrase, MAX_TEXT)}" means. Did you mean:`,
  clarifyTail: "or tell me the name of a file or feature.",
  scopeNotice: "This assistant answers questions about code and computer science, for example about this repository or a term like \"timeout\".",
  wait: (seconds: number) => `Please wait ${Math.max(1, Math.ceil(seconds))} seconds before the next question.`,
  busy: (seconds: number) => `Many people are asking right now. Try again in ${Math.max(1, Math.ceil(seconds))} seconds.`,
  error: "Something went wrong on our side. Nothing was lost; please try again.",
} as const;

/** Removes control characters and the characters that could start markup or a link, collapses white space (line and paragraph separators included), cuts to `max` without half a surrogate pair. */
export function cleanText(text: string, max: number): string {
  let s = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[<>`[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s.trim();
}

/** The last path segment, cleaned and cut to 60 characters. Empty when nothing usable is left. */
export function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter((x) => x.length > 0);
  return cleanText(segments.at(-1) ?? "", MAX_FILE_NAME);
}

export interface SuggestionInput {
  /** The question asked just before this one, when the caller has it. Absent in T-1a (T-2 fills it). */
  previousQuestion?: string;
  /** Paths of the best-ranked retrieved files, best first. */
  files?: readonly string[];
}

/**
 * Up to three distinct suggestions, never none: the previous question, then the names of the top-ranked files (README headings are
 * skipped: the index does not expose them cheaply), then the starter questions. Deduplicated by question text, ignoring case.
 */
export function buildSuggestions(input: SuggestionInput = {}): NextStepSuggestion[] {
  const out: NextStepSuggestion[] = [];
  const seen = new Set<string>();
  const add = (label: string, question: string, source: NextStepSource): void => {
    const q = cleanText(question, MAX_TEXT);
    const l = cleanText(label, MAX_TEXT);
    const key = q.toLowerCase();
    if (out.length >= MAX_SUGGESTIONS || q === "" || l === "" || seen.has(key)) return;
    seen.add(key);
    out.push({ label: l, question: q, source });
  };
  const previous = cleanText(input.previousQuestion ?? "", MAX_TEXT);
  if (previous !== "") add(`Ask again: ${previous}`, previous, "previous");
  let files = 0;
  for (const p of input.files ?? []) {
    if (files >= MAX_FILE_SUGGESTIONS) break;
    const name = fileNameOf(p);
    if (name === "") continue;
    const before = out.length;
    add(`Ask about ${name}`, `What does ${name} do?`, "file");
    if (out.length > before) files += 1;
  }
  for (const q of STARTER_QUESTIONS) add(q, q, "starter");
  return out;
}

export interface NextStepsInput extends SuggestionInput {
  /** True when the refusal also shows the closest files (state 4). */
  closestFilesShown?: boolean;
  /** A phrase of the question the system could not resolve (state 3). Absent in T-1a. */
  unresolvedPhrase?: string;
}

/** The next steps for one refusal. With no previous question the kind is `refusal`, or `closest_files` when the closest files are shown. */
export function buildNextSteps(input: NextStepsInput = {}): NextSteps {
  const kind: NextStepKind =
    input.unresolvedPhrase !== undefined && cleanText(input.unresolvedPhrase, MAX_TEXT) !== ""
      ? "clarify"
      : cleanText(input.previousQuestion ?? "", MAX_TEXT) !== ""
        ? "follow_up"
        : input.closestFilesShown === true
          ? "closest_files"
          : "refusal";
  return { kind, suggestions: buildSuggestions(input) };
}
