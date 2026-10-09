import { describe, expect, it } from "vitest";
import { answerQuestion } from "../answer/answer";
import { APP_ANSWER_SETTINGS, DEFAULT_POLICY } from "../answer/defaults";
import { SYSTEM_PROMPTS, parsePromptEvidence } from "../answer/prompt";
import { ExtractiveBaselineProvider, GroqProvider, ProviderError } from "../answer/provider";
import { DEFAULT_SEARCH_OPTIONS } from "../retrieve/defaults";
import { MapSource } from "../answer/source";
import { FILES, ScriptedModel, TEST_REPO, buildFixture } from "../answer/test-helpers";
import { GitHubHttpError } from "../github/client";
import { handleAnswer, parseAnswerBody, selectProvider } from "./answer-handler";

const body = { repo: "acme/shop", sha: TEST_REPO.sha, question: "where is loginUser implemented" };

describe("parseAnswerBody", () => {
  it.each([null, "x", {}, { repo: "a/b", sha: "a".repeat(40) }, { repo: "https://evil.com/a/b", sha: "a".repeat(40), question: "q" }, { repo: "a/b", sha: "main", question: "q" }, { repo: "a/b", sha: "a".repeat(40), question: "x".repeat(500) }, { repo: "a/b", sha: "a".repeat(40), question: "  " }])(
    "rejects %j",
    (b) => {
      expect(() => parseAnswerBody(b)).toThrow();
    },
  );
});

describe("selectProvider", () => {
  it("uses Groq only when key and model are configured, and ignores Gemini, Anthropic and the baseline", () => {
    expect(selectProvider({ GROQ_API_KEY: "k", GROQ_MODEL: "m" })).toBeInstanceOf(GroqProvider);
    expect(selectProvider({ GROQ_API_KEY: "k" })).toBeNull();
    expect(selectProvider({ GEMINI_API_KEY: "k", GEMINI_MODEL: "m" })).toBeNull();
    expect(selectProvider({ ANTHROPIC_API_KEY: "k" })).toBeNull();
    expect(selectProvider({ ANSWER_PROVIDER: "extractive" })).toBeNull();
    expect(selectProvider({})).toBeNull();
  });
});

describe("handleAnswer failure sanitising", () => {
  it("returns a generic 500 when the index store throws, without the store's message", async () => {
    const { source } = await buildFixture(FILES);
    const boom = new Error("EACCES: permission denied, open 'C:\\secret\\store\\x.idx.br'");
    const res = await handleAnswer({ provider: new ExtractiveBaselineProvider(), loadIndex: async () => { throw boom; }, makeSource: () => source }, body);
    expect(res).toEqual({ status: 500, body: { error: "internal error" } });
  });
});

describe("handleAnswer and the model's raw reply", () => {
  it("returns the validated result only: text the model wrote around its JSON never reaches a client", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel('RAW-ONLY-MARKER-1 {"status":"insufficient_evidence","missing":"nothing about that"} RAW-ONLY-MARKER-2');
    const res = await handleAnswer({ provider, loadIndex: async () => index, makeSource: () => source }, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "insufficient_evidence", missing: "nothing about that", rejections: [] });
    const sent = JSON.stringify(res.body);
    expect(sent).not.toContain("RAW-ONLY-MARKER");
    expect(Object.keys(res.body as object)).not.toContain("raw");
  });

  it("reports a reply in the pre-contract shape as rejected, with a code and without echoing the reply", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel(JSON.stringify({ status: "answered", claims: [{ text: "OLD-SHAPE-CLAIM", citations: ["E1"], quote: "export async function loginUser" }] }));
    const res = await handleAnswer({ provider, loadIndex: async () => index, makeSource: () => source }, body);
    expect(res.body).toMatchObject({ status: "rejected", claims: [], rejections: [{ code: "malformed-output" }] });
    expect(JSON.stringify(res.body)).not.toContain("OLD-SHAPE-CLAIM");
  });

  it("holds a long quote to the same check as a short one, never returns more than 400 characters of it, and refuses unread one over the ceiling", async () => {
    const { index, source } = await buildFixture(FILES);
    const reply = (quote: string) => new ScriptedModel(JSON.stringify({ status: "answered", claims: [{ text: "a claim", evidence: [{ citation: "E1", quote }] }] }));
    // Over 400 characters and not in the cited lines: withheld for the quote, like any quote that is not there.
    const made = await handleAnswer({ provider: reply("x".repeat(450)), loadIndex: async () => index, makeSource: () => source }, body);
    expect(made.body).toMatchObject({ status: "rejected", rejections: [{ code: "quote-not-in-citation", claim: 1, citation: "E1" }] });
    const kept = (made.body as { claims: { citations: { quote: string; quoteTrimmed?: boolean }[] }[] }).claims[0]!.citations[0]!;
    expect(kept.quote.length).toBeLessThanOrEqual(400);
    expect(kept.quoteTrimmed).toBe(true);
    // Over the hard ceiling: malformed, named as such, and nothing of it is echoed.
    const huge = await handleAnswer({ provider: reply("LONG-QUOTE-MARKER " + "x".repeat(4000)), loadIndex: async () => index, makeSource: () => source }, body);
    expect(huge.body).toMatchObject({ status: "rejected", claims: [], rejections: [{ code: "quote-too-long" }] });
    expect(JSON.stringify(huge.body)).not.toContain("LONG-QUOTE-MARKER");
  });

  it("runs the application's settings: prompt E, importers stated from the index, and a long verbatim quote accepted and trimmed", async () => {
    const big = Array.from({ length: 40 }, (_, i) => `export const setting${i} = "value number ${i} with some padding";`).join("\n");
    const files = { ...FILES, "src/config/settings.ts": big };
    const { index, source } = await buildFixture(files);
    const provider = new ScriptedModel((req) => {
      const block = parsePromptEvidence(req.user, req.nonce).blocks.find((b) => b.path === "src/config/settings.ts");
      return block ? JSON.stringify({ status: "answered", claims: [{ text: "The settings are constants.", evidence: [{ citation: block.id, quote: block.lines.join("\n") }] }] }) : '{"status":"insufficient_evidence","missing":"x"}';
    });
    const long = await handleAnswer({ provider, loadIndex: async () => index, makeSource: () => source }, { ...body, question: "what are setting0 and setting1 in settings" });
    expect(provider.requests[0]!.system).toBe(SYSTEM_PROMPTS.E);
    expect(long.body).toMatchObject({ status: "answered" });
    const c = (long.body as { claims: { citations: { quote: string; quoteVerbatim: boolean; quoteTrimmed?: boolean }[] }[] }).claims[0]!.citations[0]!;
    expect(big.length).toBeGreaterThan(400);
    expect(c).toMatchObject({ quoteVerbatim: true, quoteTrimmed: true });
    expect(c.quote.length).toBeLessThanOrEqual(400);

    const asked = await handleAnswer({ provider: new ScriptedModel('{"status":"insufficient_evidence","missing":"x"}'), loadIndex: async () => index, makeSource: () => source }, { ...body, question: "Which modules import hashPassword?" });
    expect((asked.body as { indexFacts?: { kind: string; target: string }[] }).indexFacts).toMatchObject([{ kind: "importers", target: "hashPassword" }]);
  });
});

describe("handleAnswer", () => {
  async function deps(over: Partial<Parameters<typeof handleAnswer>[0]> = {}) {
    const { index, source } = await buildFixture(FILES);
    return { provider: new ExtractiveBaselineProvider(), loadIndex: async () => index, makeSource: () => source, ...over };
  }

  it("answers with application-built evidence locators and no source text", async () => {
    const out = await handleAnswer(await deps(), body);
    expect(out.status).toBe(200);
    const b = out.body as { status: string; evidence: { url: string }[] };
    expect(b.status).toBe("answered");
    expect(b.evidence[0]?.url).toMatch(/^https:\/\/github\.com\/acme\/shop\/blob\/d{40}\//);
    expect(JSON.stringify(out.body)).not.toContain("hashPassword(password)");
  });

  it("returns 400 for bad input, 503 without a provider, 404 without an index", async () => {
    expect((await handleAnswer(await deps(), { nope: 1 })).status).toBe(400);
    expect((await handleAnswer(await deps({ provider: null }), body)).status).toBe(503);
    expect((await handleAnswer(await deps({ loadIndex: async () => null }), body)).status).toBe(404);
  });

  it("maps a model failure to 502 and a GitHub rate limit to 503 without leaking detail", async () => {
    const failing = { name: "f", complete: async () => { throw new Error("secret-detail"); } };
    const r1 = await handleAnswer(await deps({ provider: failing }), body);
    expect(r1.status).toBe(502);
    expect(JSON.stringify(r1.body)).not.toContain("secret-detail");

    const limited = { getFile: async () => { throw new GitHubHttpError(403, "https://api.github.com/x", "0"); } };
    const r2 = await handleAnswer(await deps({ makeSource: () => limited }), body);
    expect(r2).toEqual({ status: 503, body: { error: "source rate limited; retry later", code: "source_rate_limited" } });

    const broken = { getFile: async () => { throw new Error("db password hunter2"); } };
    const r3 = await handleAnswer(await deps({ makeSource: () => broken }), body);
    expect(r3).toEqual({ status: 500, body: { error: "internal error" } });
  });

  it("answers 429 when the model's own rate limit refused the call, passing on its wait only when it stated one, and keeps the evidence", async () => {
    const throwing = (err: Error) => ({ name: "groq", complete: async () => { throw err; } });

    const hinted = await handleAnswer(await deps({ provider: throwing(new ProviderError("rate_limited", 429, 12_300)) }), body);
    expect(hinted.status).toBe(429);
    expect(hinted.headers).toEqual({ "Retry-After": "13" });
    const b = hinted.body as { status: string; reasons: string[]; evidence: unknown[] };
    expect(b).toMatchObject({ status: "provider_error", reasons: ["model provider failed: rate_limited"] });
    expect(b.evidence.length).toBeGreaterThan(0);

    const unhinted = await handleAnswer(await deps({ provider: throwing(new ProviderError("rate_limited", 429)) }), body);
    expect(unhinted.status).toBe(429);
    expect(unhinted.headers).toBeUndefined();

    const other = await handleAnswer(await deps({ provider: throwing(new ProviderError("http", 500)) }), body);
    expect(other.status).toBe(502);
    expect(other.headers).toBeUndefined();

    // What the route needs to know: the model turned the call away (so it is not counted), and the wait it stated, if any.
    expect(hinted.modelRefused).toEqual({ retryAfterMs: 12_300 });
    expect(unhinted.modelRefused).toEqual({ retryAfterMs: null });
    expect(other.modelRefused).toEqual({ retryAfterMs: null });
    for (const err of [new ProviderError("http", 400), new ProviderError("timeout"), new ProviderError("blocked"), new Error("x")]) {
      const out = await handleAnswer(await deps({ provider: throwing(err) }), body);
      expect(out.status).toBe(502);
      expect(out.modelRefused).toBeUndefined();
    }
    expect((await handleAnswer(await deps(), body)).modelRefused).toBeUndefined();
  });

  it("hands the model exactly the request and signal the pipeline built, and returns its reply untouched", async () => {
    const direct: unknown[][] = [];
    const viaHandler: unknown[][] = [];
    const recorder = (into: unknown[][]) => ({
      name: "recorder",
      complete: async (...args: unknown[]) => {
        into.push(args);
        return '{"status":"insufficient_evidence","missing":"x"}';
      },
    });
    const d = await deps({ provider: recorder(viaHandler) });
    const out = await handleAnswer(d, body);
    expect(out).toMatchObject({ status: 200, body: { status: "insufficient_evidence", missing: "x" } });
    expect(viaHandler).toHaveLength(1);
    expect(viaHandler[0]).toHaveLength(2);
    expect(viaHandler[0]![1]).toBeInstanceOf(AbortSignal);
    // The same question through the pipeline without the handler: the request differs only in its per-call nonce.
    await answerQuestion({ index: (await d.loadIndex(parseAnswerBody(body).key))!, repo: parseAnswerBody(body).key, source: d.makeSource(), provider: recorder(direct), searchOptions: DEFAULT_SEARCH_OPTIONS, policy: DEFAULT_POLICY, ...APP_ANSWER_SETTINGS }, body.question);
    const strip = (args: unknown[]) => {
      const { nonce, onUsage, ...rest } = args[0] as { nonce: string; onUsage: unknown; system: string; user: string };
      void onUsage;
      return JSON.parse(JSON.stringify(rest).split(nonce).join("NONCE")) as unknown;
    };
    expect(strip(viaHandler[0]!)).toEqual(strip(direct[0]!));
  });

  it("answers no_evidence when the commit's source cannot be verified", async () => {
    const out = await handleAnswer(await deps({ makeSource: () => new MapSource(new Map()) }), body);
    expect((out.body as { status: string }).status).toBe("no_evidence");
  });
});
