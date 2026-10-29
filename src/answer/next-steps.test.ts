import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_OPTIONS } from "../retrieve/defaults";
import { answerQuestion, type AnswerDeps } from "./answer";
import { BROAD_APP_ANSWER_SETTINGS, DEFAULT_POLICY } from "./defaults";
import { MAX_FILE_NAME, MAX_SUGGESTIONS, MAX_TEXT, NEXT_STEP_COPY, STARTER_QUESTIONS, buildNextSteps, buildSuggestions, cleanText, fileNameOf } from "./next-steps";
import { FILES, ScriptedModel, TEST_REPO, buildFixture } from "./test-helpers";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function expectWellFormed(list: ReturnType<typeof buildSuggestions>): void {
  expect(list.length).toBeGreaterThanOrEqual(1);
  expect(list.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  const questions = list.map((s) => s.question.toLowerCase());
  expect(new Set(questions).size).toBe(questions.length);
  for (const s of list) {
    for (const text of [s.label, s.question]) {
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT);
      expect(CONTROL.test(text)).toBe(false);
      expect(/[<>`[\]]/.test(text)).toBe(false);
    }
  }
}

describe("buildSuggestions: adversarial inputs (g)", () => {
  it("HTML in a file name is never passed on as markup", () => {
    const list = buildSuggestions({ files: ["src/<script>alert(1)</script>.js"] });
    expectWellFormed(list);
    expect(list[0]!.source).toBe("file");
    expect(list[0]!.question).toBe("What does script.js do?"); // the last path segment of "<script>alert(1)</script>.js" is "script>.js"
    expect(JSON.stringify(list)).not.toContain("<");
  });

  it("a 5000-character file name is cut to 60 characters in the file part", () => {
    const long = "a".repeat(5000) + ".ts";
    const list = buildSuggestions({ files: [`src/${long}`] });
    expectWellFormed(list);
    expect(fileNameOf(`src/${long}`).length).toBe(MAX_FILE_NAME);
    expect(list[0]!.question).toBe(`What does ${"a".repeat(MAX_FILE_NAME)} do?`);
    expect(JSON.stringify(list).length).toBeLessThan(1500);
  });

  it("control characters in a file name are removed", () => {
    const list = buildSuggestions({ files: ["src/a\u0000b\u001b[31m\nc\u007fd e.ts"] });
    expectWellFormed(list);
    expect(CONTROL.test(JSON.stringify(list).replace(/\\u[0-9a-f]{4}/gi, "?"))).toBe(false);
  });

  it("markdown link syntax is neutralised", () => {
    const list = buildSuggestions({ files: ["docs/[click](http://evil.example/x).md"], previousQuestion: "see [this](javascript:alert(1)) `code`" });
    expectWellFormed(list);
    expect(JSON.stringify(list)).not.toMatch(/\]\(/);
  });

  it("an empty index (no files) offers only the starter questions", () => {
    const list = buildSuggestions({ files: [] });
    expectWellFormed(list);
    expect(list.map((s) => s.question)).toEqual([...STARTER_QUESTIONS]);
    expect(list.every((s) => s.source === "starter")).toBe(true);
    expect(buildSuggestions().map((s) => s.question)).toEqual([...STARTER_QUESTIONS]);
  });

  it("duplicate file names (same name in several folders, or the same path twice) give one suggestion", () => {
    const list = buildSuggestions({ files: ["a/index.ts", "b/index.ts", "a/index.ts", "c/INDEX.ts"] });
    expectWellFormed(list);
    expect(list.filter((s) => s.source === "file")).toHaveLength(1);
  });

  it("never more than 3, never empty, at most two file suggestions, a starter always follows", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const list = buildSuggestions({ files, previousQuestion: "How does login work?" });
    expectWellFormed(list);
    expect(list.map((s) => s.source)).toEqual(["previous", "file", "file"]);
    const noPrev = buildSuggestions({ files });
    expect(noPrev.map((s) => s.source)).toEqual(["file", "file", "starter"]);
  });

  it("junk inputs (empty names, only control characters, only separators) still give a non-empty list", () => {
    for (const files of [[""], ["\u0000\u0001"], ["///"], ["<>"], ["[]"]]) expectWellFormed(buildSuggestions({ files, previousQuestion: "\u0000   " }));
  });

  it("does not leave half a surrogate pair when it cuts", () => {
    const s = cleanText("x".repeat(59) + "😀😀", MAX_FILE_NAME);
    expect(s.length).toBeLessThanOrEqual(MAX_FILE_NAME);
    const last = s.charCodeAt(s.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("a starter question already asked as the previous question is not offered twice", () => {
    const list = buildSuggestions({ previousQuestion: "what is this repository?" });
    expectWellFormed(list);
    expect(list.map((s) => s.question.toLowerCase()).filter((q) => q === "what is this repository?")).toHaveLength(1);
  });
});

describe("buildNextSteps kinds", () => {
  it("refusal, closest_files, follow_up and clarify", () => {
    expect(buildNextSteps({}).kind).toBe("refusal");
    expect(buildNextSteps({ closestFilesShown: true }).kind).toBe("closest_files");
    expect(buildNextSteps({ previousQuestion: "How does login work?" }).kind).toBe("follow_up");
    expect(buildNextSteps({ unresolvedPhrase: "the other one" }).kind).toBe("clarify");
    expect(buildNextSteps({ previousQuestion: "   " }).kind).toBe("refusal");
  });
});

describe("English copy of section 5.3", () => {
  it("matches the document with placeholders filled and exposes no internals", () => {
    expect(NEXT_STEP_COPY.refusal).toBe("I could not find this in the code yet. Try a more specific question, for example:");
    expect(NEXT_STEP_COPY.followUp("How does login work?")).toBe('This looks like a follow-up to "How does login work?".');
    expect(NEXT_STEP_COPY.followUpAgain).toBe("Ask again about that topic");
    expect(NEXT_STEP_COPY.followUpNew).toBe("Ask something new");
    expect(NEXT_STEP_COPY.clarify("the other one")).toBe('I am not sure what "the other one" means. Did you mean:');
    expect(NEXT_STEP_COPY.clarifyTail).toBe("or tell me the name of a file or feature.");
    expect(NEXT_STEP_COPY.wait(12)).toBe("Please wait 12 seconds before the next question.");
    expect(NEXT_STEP_COPY.busy(5)).toBe("Many people are asking right now. Try again in 5 seconds.");
    expect(NEXT_STEP_COPY.error).toBe("Something went wrong on our side. Nothing was lost; please try again.");
    const all = [NEXT_STEP_COPY.refusal, NEXT_STEP_COPY.followUp("q"), NEXT_STEP_COPY.clarify("q"), NEXT_STEP_COPY.scopeNotice, NEXT_STEP_COPY.wait(1), NEXT_STEP_COPY.busy(1), NEXT_STEP_COPY.error].join(" ");
    expect(all).not.toMatch(/coverage|policy|retriev|index|BM25|token|stack|exception|model_|groq|429|503|500/i);
  });

  it("hostile placeholders are cleaned", () => {
    expect(NEXT_STEP_COPY.followUp("<script>x</script>\u0000" + "q".repeat(500)).length).toBeLessThan(200);
    expect(NEXT_STEP_COPY.followUp("<b>x</b>")).not.toContain("<");
    expect(NEXT_STEP_COPY.clarify("`a`[b](c)")).not.toMatch(/[`[\]]/);
  });

  it("does not contain the W-15 pause or daily-limit copy", () => {
    const src = readFileSync("src/answer/next-steps.ts", "utf8");
    expect(src).not.toMatch(/paused until|today's 10 questions|will pause questions/);
  });
});

describe("answerQuestion with nextSteps: no model call is added (C6)", () => {
  // English-looking words the fixture does not contain: refused by the policy before the model, with no keyword-translation call either.
  const UNMATCHED = "How does the kubernetes helm chart handle blue green rollback";
  const settings = { searchOptions: DEFAULT_SEARCH_OPTIONS, policy: DEFAULT_POLICY, ...BROAD_APP_ANSWER_SETTINGS };

  async function run(question: string, nextSteps: boolean, reply: string) {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel(reply);
    const deps: AnswerDeps = { index, repo: TEST_REPO, source, provider, ...settings, ...(nextSteps ? { nextSteps: true } : {}) };
    const res = await answerQuestion(deps, question);
    return { res, calls: provider.requests.length };
  }
  const INSUFFICIENT = '{"status":"insufficient_evidence","missing":"x"}';

  it("a pre-model refusal carries 1 to 3 suggestions and costs no model call, with the flag ON or OFF", async () => {
    const off = await run(UNMATCHED, false, INSUFFICIENT);
    const on = await run(UNMATCHED, true, INSUFFICIENT);
    expect(off.res.status).toBe("insufficient_evidence");
    expect(off.res.stats.modelCalled).toBe(false);
    expect(on.calls).toBe(off.calls);
    expect(on.calls).toBe(0);
    expect(on.res.nextSteps).toBeDefined();
    expectWellFormed(on.res.nextSteps!.suggestions);
    expect(Object.keys(off.res)).not.toContain("nextSteps");
  });

  it("a refusal from the model also carries next steps, with the same number of model calls as OFF", async () => {
    const off = await run("where is loginUser implemented", false, INSUFFICIENT);
    const on = await run("where is loginUser implemented", true, INSUFFICIENT);
    expect(off.calls).toBeGreaterThanOrEqual(1);
    expect(on.calls).toBe(off.calls);
    expect(on.res.status).toBe("insufficient_evidence");
    expectWellFormed(on.res.nextSteps!.suggestions);
    expect(on.res.nextSteps!.suggestions.some((s) => s.source === "file")).toBe(true);
  });

  it("an answered result gets no nextSteps even with the flag ON, and OFF has no new keys, not even undefined ones", async () => {
    const { index, source } = await buildFixture(FILES);
    const block = (await answerQuestion({ index, repo: TEST_REPO, source, provider: new ScriptedModel(INSUFFICIENT), ...settings }, "where is loginUser implemented")).evidence[0]!;
    const reply = JSON.stringify({ status: "answered", claims: [{ text: "A function.", evidence: [{ citation: block.id, quote: FILES[block.path]!.split("\n")[block.startLine - 1]!.trim() }] }] });
    const on = await run("where is loginUser implemented", true, reply);
    expect(Object.keys(on.res)).not.toContain("nextSteps");
    const off = await run(UNMATCHED, false, INSUFFICIENT);
    const keys = Object.keys(off.res).sort();
    expect(keys).not.toContain("nextSteps");
    expect(keys).not.toContain("leads");
    expect(keys).not.toContain("refusalReason");
  });

  it("with leadsOnRefusal as well, the kind is closest_files when files are shown", async () => {
    const { index, source } = await buildFixture(FILES);
    const res = await answerQuestion({ index, repo: TEST_REPO, source, provider: new ScriptedModel(INSUFFICIENT), ...settings, leadsOnRefusal: true, nextSteps: true }, UNMATCHED);
    expect(res.nextSteps).toBeDefined();
    expect(res.nextSteps!.kind).toBe(res.leads && res.leads.length > 0 ? "closest_files" : "refusal");
  });
});

describe("next-steps.ts imports no provider and makes no call (C6)", () => {
  it("has no import of the provider, the network or a model name", () => {
    const src = readFileSync("src/answer/next-steps.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/provider|fetch\(|groq|node:http|node:net/i);
  });
});
