import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AnswerResult } from "../answer/answer";
import { clarifyText, describeAnswer, describeFailure, describeNextSteps, followUpNote, SCOPE_NOTICE } from "./answer-view";
import { classifyFailure, type ApiFailure } from "./api";
import { AnswerEntry } from "./AnswerEntry";
import type { ThreadEntry } from "./store";

// Markup is produced by rendering the real card with react-dom/server (renderToStaticMarkup), as in leads-card.test.ts.
const REFUSAL = "I could not find this in the code yet. Try a more specific question, for example:";
const OLD_DETAIL = "The search matched too little of this repository to support an answer, so the model was not asked. Try naming a function, file or option that appears in the code.";

function refusal(nextSteps?: unknown, modelCalled = false): AnswerResult {
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
    stats: { retrievalMs: 0, sourceMs: 0, modelMs: 0, validateMs: 0, evidenceCount: 0, evidenceChars: 0, omittedForBudget: 0, promptChars: 0, modelCalled, inputTokens: null, outputTokens: null },
    ...(nextSteps === undefined ? {} : { nextSteps: nextSteps as AnswerResult["nextSteps"] }),
  };
}
function render(result: AnswerResult, onAsk?: (q: string) => void): string {
  const entry: ThreadEntry = { id: "e1", question: "Where is X?", outcome: { kind: "result", result } } as ThreadEntry;
  return renderToStaticMarkup(createElement(AnswerEntry, { entry, selectedEvidenceId: null, onInspect: () => {}, onRetry: () => {}, busy: false, ...(onAsk ? { onAsk } : {}) }));
}
const step = (label: string, question = label) => ({ label, question, source: "starter" });
const steps = (...s: ReturnType<typeof step>[]) => ({ kind: "refusal", suggestions: s });
const failure = (over: Partial<ApiFailure>): ApiFailure => ({ ok: false, kind: "rate_limited", status: 429, serverMessage: null, retryAfterSeconds: null, ...over });

describe("(a) results without nextSteps render as before", () => {
  it("no list, no heading, no button; the old detail text byte for byte", () => {
    const html = render(refusal());
    expect(html).not.toContain("Suggested questions");
    expect(html).not.toContain(REFUSAL);
    expect(html).not.toContain("<button");
    expect(html).toContain(OLD_DETAIL);
    expect(describeAnswer(refusal())).not.toHaveProperty("nextSteps");
  });
  it("a model-called refusal keeps its own detail", () => {
    expect(describeAnswer(refusal(undefined, true)).detail).toBe("The model read the evidence below and found that it does not answer the question.");
  });
});

describe("(b) results with nextSteps", () => {
  const html = render(refusal(steps(step("What is this repository?"), step("Ask about auth.ts", "What does auth.ts do?"), step("How is it organized?"))));
  it("shows state 1 text instead of the pre-model detail, once, with a labelled list", () => {
    expect(html).toContain(REFUSAL);
    expect(html.split(REFUSAL)).toHaveLength(2);
    expect(html).not.toContain(OLD_DETAIL);
    expect(html).toMatch(/<ul aria-label="Suggested questions"[^>]*>/);
  });
  it("one real button per suggestion: visible text is the label, accessible name is the question", () => {
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
    expect(html).toMatch(/<button type="button"[^>]*aria-label="What does auth\.ts do\?"[^>]*>Ask about auth\.ts<\/button>/);
    expect(html).toContain('aria-label="What is this repository?"');
  });
  it("a refusal where the model was called keeps its detail and gets the heading above the list", () => {
    const h = render(refusal(steps(step("What is this repository?")), true));
    expect(h).toContain("The model read the evidence below and found that it does not answer the question.");
    expect(h).toContain(REFUSAL);
  });
  it("the closest-files card and the suggestions can both be shown", () => {
    const withLeads = { ...refusal(steps(step("How do I run it?"))), leads: [{ path: "src/a.ts", startLine: 1, endLine: 2, rank: 1 }], refusalReason: "pre-model-coverage" as const };
    const h = render(withLeads);
    expect(h).toContain('aria-label="Closest files"');
    expect(h).toContain('aria-label="Suggested questions"');
  });
});

describe("(c) hostile text is escaped, capped and cleaned", () => {
  const hostile = ["<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "[x](javascript:alert(1))", "a".repeat(5000), "line one\nline two\u0001\u0000end"];
  const html = render(refusal({ kind: "refusal", suggestions: hostile.map((h) => step(h)) }));
  it("no markup, no link, no handler, no raw script", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("dangerouslySetInnerHTML");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).not.toContain("javascript:alert(1)](");
  });
  it("at most three buttons, text capped at 120 characters, control characters and newlines gone", () => {
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).not.toContain("a".repeat(121));
    const view = describeNextSteps({ kind: "refusal", suggestions: [step("line one\nline two\u0001\u0000end"), step("a".repeat(5000))] })!;
    expect(view.suggestions[0]!.label).toBe("line one line two end");
    expect(view.suggestions[1]!.label).toHaveLength(120);
    expect(view.suggestions[1]!.question).toHaveLength(120);
  });
  it("malformed input is ignored", () => {
    const bad: unknown[] = [null, 5, "x", {}, { label: 1, question: "q" }, { label: "l" }, { label: "<>", question: "q" }, step("ok")];
    expect(describeNextSteps({ kind: "refusal", suggestions: bad })!.suggestions).toEqual([{ label: "ok", question: "ok" }]);
    for (const raw of [undefined, null, "x", 3, {}, { suggestions: "no" }]) expect(describeNextSteps(raw)).toBeNull();
  });
});

describe("(d) failure copy", () => {
  it("wait, busy and error use the plain copy of section 5.3", () => {
    expect(describeFailure(failure({ guidance: "wait", retryAfterSeconds: 120 }), "answer").detail).toBe("Please wait 120 seconds before the next question.");
    expect(describeFailure(failure({ guidance: "wait", retryAfterSeconds: 1.2 }), "answer").detail).toBe("Please wait 2 seconds before the next question.");
    expect(describeFailure(failure({ guidance: "wait", retryAfterSeconds: null }), "answer").detail).toBe("Please wait 1 seconds before the next question.");
    expect(describeFailure(failure({ guidance: "busy", kind: "busy", status: 503, retryAfterSeconds: 5 }), "answer").detail).toBe("Many people are asking right now. Try again in 5 seconds.");
    expect(describeFailure(failure({ guidance: "error", kind: "server", status: 500 }), "answer").detail).toBe("Something went wrong on our side. Nothing was lost; please try again.");
  });
  it("without guidance the old texts are unchanged", () => {
    expect(describeFailure(failure({}), "answer")).toEqual({ title: "Too many requests", detail: "This server limits how often it can be asked. Wait a moment and try again.", canRetry: true });
    expect(describeFailure(failure({ kind: "server", status: 500 }), "answer").detail).toBe("The error was logged. Try again; if it keeps happening, the server needs attention.");
  });
  it("api.ts passes guidance and the wait through, and ignores anything else", () => {
    expect(classifyFailure(429, { error: "x", code: "rate_limited", retryAfterSeconds: 120, guidance: "wait" })).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 120, guidance: "wait" });
    expect(classifyFailure(500, { guidance: "error" })).toMatchObject({ kind: "server", guidance: "error" });
    expect(classifyFailure(429, { code: "rate_limited", guidance: "<b>" })).not.toHaveProperty("guidance");
    expect(classifyFailure(429, { code: "rate_limited" })).not.toHaveProperty("guidance");
  });
});

describe("(e) builders equal the design copy", () => {
  it("clarify, follow-up note and scope notice", () => {
    expect(clarifyText("the other one")).toBe('I am not sure what "the other one" means. Did you mean:');
    expect(followUpNote("How do timeouts work?")).toBe('This looks like a follow-up to "How do timeouts work?".');
    expect(SCOPE_NOTICE).toBe('This assistant answers questions about code and computer science, for example about this repository or a term like "timeout".');
    expect(clarifyText("<b>x</b>[y]")).toBe('I am not sure what "bx/by" means. Did you mean:');
  });
});

describe("(f) empty list and missing handler", () => {
  it("an empty list renders no heading and no list", () => {
    const html = render(refusal({ kind: "refusal", suggestions: [] }));
    expect(html).not.toContain("Suggested questions");
    expect(html).not.toContain(REFUSAL);
    expect(html).toContain(OLD_DETAIL);
  });
  it("a missing onAsk still renders the card with its buttons", () => {
    const html = render(refusal(steps(step("What is this repository?"))));
    expect(html).toContain('aria-label="Suggested questions"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("(g) nothing is asked on render", () => {
  it("onAsk is not called while rendering", () => {
    const onAsk = vi.fn();
    render(refusal(steps(step("What is this repository?"))), onAsk);
    expect(onAsk).not.toHaveBeenCalled();
  });
});
