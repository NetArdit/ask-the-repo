import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AnswerResult } from "../answer/answer";
import { describeAnswer, describeFollowup, previousTurn } from "./answer-view";
import { AnswerEntry } from "./AnswerEntry";
import { askQuestion } from "./api";
import type { ThreadEntry } from "./store";

function result(over: Partial<AnswerResult> = {}): AnswerResult {
  return {
    status: "insufficient_evidence",
    claims: [],
    reasons: [],
    rejections: [],
    warnings: [],
    evidence: [],
    rejectedEvidence: [],
    policy: { action: "insufficient", reason: "x" },
    features: {} as AnswerResult["features"],
    provider: "scripted",
    stats: { retrievalMs: 0, sourceMs: 0, modelMs: 0, validateMs: 0, evidenceCount: 0, evidenceChars: 0, omittedForBudget: 0, promptChars: 0, modelCalled: false, inputTokens: null, outputTokens: null },
    ...over,
  };
}
const answered = (): AnswerResult =>
  result({
    status: "answered",
    stats: { ...result().stats, modelCalled: true },
    evidence: [
      { id: "E1", key: "k1", path: "src/a.ts", startLine: 3, endLine: 9, url: "u", injectionSuspect: false },
      { id: "E2", key: "k2", path: "src/b.ts", startLine: 1, endLine: 2, url: "u", injectionSuspect: false },
    ],
    claims: [{ text: "c", status: "cited", citations: [{ id: "E1", verdict: { valid: true } as never, quote: "q", quoteVerbatim: true }, { id: "E2", verdict: { valid: false } as never, quote: "q", quoteVerbatim: false }] }] as never,
  });
const entry = (question: string, r: AnswerResult): { question: string; outcome: { kind: string; result?: AnswerResult } } => ({ question, outcome: { kind: "result", result: r } });
const render = (question: string, r: AnswerResult, onAskNew?: () => void) =>
  renderToStaticMarkup(createElement(AnswerEntry, { entry: { id: "e1", question, outcome: { kind: "result", result: r } } as ThreadEntry, selectedEvidenceId: null, onInspect: () => {}, onRetry: () => {}, busy: false, ...(onAskNew ? { onAskNew } : {}) }));

describe("previousTurn", () => {
  it("is nothing for an empty thread, a pending turn or a failed one", () => {
    expect(previousTurn([])).toBeNull();
    expect(previousTurn([{ question: "q", outcome: { kind: "pending" } }])).toBeNull();
    expect(previousTurn([{ question: "q", outcome: { kind: "failure" } }])).toBeNull();
    expect(previousTurn([entry("q", result({ status: "rejected" }))])).toBeNull();
  });
  it("sends only the newest turn, with the files of its valid citations", () => {
    const p = previousTurn([entry("newest question", answered()), entry("older question", result())]);
    expect(p).toEqual({ question: "newest question", outcome: "answered", files: [{ path: "src/a.ts", startLine: 3, endLine: 9 }] });
  });
  it("a refusal is sent as a refused turn without files", () => {
    expect(previousTurn([entry("why", result())])).toEqual({ question: "why", outcome: "refused", files: [] });
  });
  it("caps a long question at 300 characters", () => {
    expect(previousTurn([entry("x".repeat(400), answered())])!.question).toHaveLength(300);
  });
});

describe("the follow-up line", () => {
  const inherited = result({ followup: { inherited: true, from: "where are request timeouts applied?" } });
  it("is a neutral sentence and a real button 'Ask as a new question'", () => {
    const html = render("how do they work", inherited);
    expect(html).toContain('This looks like a follow-up to &quot;where are request timeouts applied?&quot;.');
    expect(html).toMatch(/<button type="button"[^>]*>Ask as a new question<\/button>/);
    expect(html).toContain("data-followup");
  });
  it("escapes hostile text and shows no markup or link from it", () => {
    const html = render("q", result({ followup: { inherited: true, from: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) `y`' } }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("`");
  });
  it("is absent without the marker, for a clarify result, and for malformed markers", () => {
    expect(describeFollowup(result())).toBeNull();
    expect(describeFollowup(result({ followup: { inherited: false } }))).toBeNull();
    for (const bad of [null, 5, "x", [], { inherited: "true", from: "q" }, { inherited: true }, { inherited: true, from: 7 }, { inherited: true, from: "<>`[]" }]) expect(describeFollowup({ followup: bad })).toBeNull();
    expect(render("q", result())).not.toContain("data-followup");
  });
  it("the button calls the handler and is disabled while a question runs", () => {
    expect(render("q", inherited, () => {})).toContain("Ask as a new question");
    const busy = renderToStaticMarkup(createElement(AnswerEntry, { entry: { id: "e1", question: "q", outcome: { kind: "result", result: inherited } } as ThreadEntry, selectedEvidenceId: null, onInspect: () => {}, onRetry: () => {}, busy: true }));
    expect(busy).toMatch(/<button type="button"[^>]*disabled[^>]*>Ask as a new question/);
  });
});

describe("the clarifying card (state 3)", () => {
  const clarify = result({ followup: { inherited: false }, nextSteps: { kind: "clarify", suggestions: [{ label: "What is this repository?", question: "What is this repository?", source: "starter" }] } });
  it("names the words typed, offers buttons and no model text", () => {
    const view = describeAnswer(clarify, undefined, "the other one");
    expect(view.title).toBe("Which topic do you mean?");
    expect(view.detail).toBe('I am not sure what "the other one" means. Did you mean:');
    expect(view.nextSteps?.suggestions).toHaveLength(1);
    const html = render("the other one", clarify);
    expect(html).toContain("I am not sure what &quot;the other one&quot; means. Did you mean:");
    expect(html).toContain('aria-label="What is this repository?"');
    expect(html).not.toContain("data-followup");
  });
  it("without the question the card is the ordinary refusal card", () => {
    expect(describeAnswer(clarify).title).toBe("Not enough evidence to answer");
  });
});

describe("askQuestion sends `previous` only when there is one", () => {
  it("leaves the body exactly as it was without a previous turn", async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    try {
      await askQuestion("a/b", "a".repeat(40), "q");
      await askQuestion("a/b", "a".repeat(40), "q", undefined, { question: "p", outcome: "answered", files: [] });
    } finally {
      globalThis.fetch = real;
    }
    expect(sent[0]).toBe('{"repo":"a/b","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","question":"q"}');
    expect(JSON.parse(sent[1]!)).toMatchObject({ question: "q", previous: { question: "p", outcome: "answered", files: [] } });
  });
});
