import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerResult } from "../answer/answer";
import { describeAnswer, describeFact, describeFailure, retryTime } from "./answer-view";
import { askQuestion, classifyFailure, fetchSource, ingestRepository, rememberedSource } from "./api";
import { parseRepoInput } from "./repo-input";
import { githubUrl } from "./store";

afterEach(() => vi.unstubAllGlobals());

describe("parseRepoInput", () => {
  it.each([
    ["sindresorhus/ky", "sindresorhus", "ky"],
    ["  sindresorhus/ky  ", "sindresorhus", "ky"],
    ["github.com/sindresorhus/ky", "sindresorhus", "ky"],
    ["https://github.com/sindresorhus/ky", "sindresorhus", "ky"],
    ["https://www.github.com/sindresorhus/ky/", "sindresorhus", "ky"],
    ["https://github.com/sindresorhus/ky.git", "sindresorhus", "ky"],
    ["git@github.com:sindresorhus/ky.git", "sindresorhus", "ky"],
    ["https://github.com/vercel/next.js?tab=readme#top", "vercel", "next.js"],
  ])("accepts %s", (input, owner, repo) => {
    expect(parseRepoInput(input)).toMatchObject({ ok: true, owner, repo, note: null });
  });

  it("keeps the repository and says the rest of a deep link was ignored", () => {
    const r = parseRepoInput("https://github.com/honojs/hono/tree/main/src/router");
    expect(r).toMatchObject({ ok: true, owner: "honojs", repo: "hono" });
    expect(r.ok && r.note).toContain("default branch");
  });

  it.each(["", "   ", "ky", "github.com", "https://github.com/onlyowner", "https://gitlab.com/a/b", "evil.example/a/b", "a b/c", "../../etc", "owner/..", "javascript:alert(1)//x/y", "x".repeat(400)])(
    "refuses %j with a message",
    (input) => {
      const r = parseRepoInput(input);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message.length).toBeGreaterThan(10);
    },
  );
});

describe("classifyFailure", () => {
  it.each([
    [400, { error: "repo is required" }, "invalid"],
    [404, { error: "repository or commit not found" }, "not_found"],
    [404, { error: "index not found for this commit", code: "not_indexed" }, "not_indexed"],
    [404, { error: "index not found for this commit" }, "not_found"], // classified by code, never by wording
    [413, { error: "Ingestion limit exceeded: compressed-bytes > 1", limit: "compressed-bytes" }, "too_large"],
    [422, { error: "x" }, "unprocessable"],
    [429, { error: "x", code: "rate_limited", retryAfterSeconds: 10 }, "rate_limited"],
    [429, { error: "x", code: "daily_limit", retryAfterSeconds: 4000 }, "daily_limit"],
    [503, { error: "x", code: "busy", retryAfterSeconds: 5 }, "busy"],
    [503, { error: "GitHub rate limit reached; retry later", code: "github_rate_limited" }, "github_rate_limited"],
    [503, { error: "source rate limited; retry later", code: "source_rate_limited" }, "github_rate_limited"],
    [503, { error: "no model provider is configured", code: "no_provider" }, "no_provider"],
    [503, { error: "reworded message" }, "server"],
    [500, { error: "internal error" }, "server"],
    [500, null, "server"],
  ])("%i %j -> %s", (status, body, kind) => {
    expect(classifyFailure(status, body).kind).toBe(kind);
  });

  it("carries the retry delay only when the server gave a sensible one", () => {
    expect(classifyFailure(429, { retryAfterSeconds: 12 }).retryAfterSeconds).toBe(12);
    expect(classifyFailure(429, { retryAfterSeconds: "soon" }).retryAfterSeconds).toBeNull();
    expect(classifyFailure(429, { retryAfterSeconds: -3 }).retryAfterSeconds).toBeNull();
  });
});

const evidence = [
  { id: "E1", key: "k1", path: "src/a.ts", startLine: 1, endLine: 9, url: "https://github.com/a/b/blob/sha/src/a.ts#L1-L9", injectionSuspect: false },
  { id: "E2", key: "k2", path: "src/b.ts", startLine: 5, endLine: 20, url: "https://github.com/a/b/blob/sha/src/b.ts#L5-L20", injectionSuspect: true },
];

function result(over: Partial<AnswerResult>): AnswerResult {
  return {
    status: "answered",
    claims: [],
    reasons: [],
    rejections: [],
    warnings: [],
    evidence,
    rejectedEvidence: [],
    policy: { action: "answer", reason: "coverage sufficient" },
    features: {} as AnswerResult["features"],
    provider: "groq",
    stats: { retrievalMs: 1, sourceMs: 1, modelMs: 1, validateMs: 1, evidenceCount: 2, evidenceChars: 10, omittedForBudget: 0, promptChars: 10, modelCalled: true, inputTokens: 1, outputTokens: 1 },
    ...over,
  } as AnswerResult;
}

describe("describeAnswer", () => {
  it("presents an accepted answer with each citation resolved to its evidence and says what was checked", () => {
    const v = describeAnswer(
      result({
        claims: [
          { text: "A does X.", citations: [{ id: "E1", verdict: { valid: true }, quote: "const a = 1;", quoteVerbatim: true }], quoteVerbatim: true, status: "cited" },
          { text: "B does Y.", citations: [{ id: "E2", verdict: { valid: true }, quote: "const b = 2;", quoteVerbatim: true }], quoteVerbatim: true, status: "cited" },
        ],
      }),
    );
    expect(v.tone).toBe("answered");
    expect(v.claims[0]!.citations[0]).toMatchObject({ id: "E1", valid: true, evidence: { path: "src/a.ts" }, quote: "const a = 1;", quoteVerbatim: true });
    expect(v.claims[0]!.check).toContain("word for word");
    expect(v.claims[0]!.check).not.toMatch(/support/i);
    expect(v.citedIds).toEqual(["E1", "E2"]);
    expect(v.canRetry).toBe(false);
  });

  it("never frames a rejected reply as an answer, and explains the failed check in plain words", () => {
    const v = describeAnswer(
      result({
        status: "rejected",
        reasons: ["server wording that the interface must not depend on"],
        rejections: [
          { code: "quote-not-in-citation", claim: 2, citation: "E2" },
          { code: "invalid-citation", claim: 3, citation: "E9", detail: "unknown-evidence-id" },
          { code: "uncited-claim", claim: 4 },
          { code: "malformed-output", detail: "output is not a JSON object" },
        ],
        claims: [
          { text: "ok", citations: [{ id: "E1", verdict: { valid: true }, quote: "const a = 1;", quoteVerbatim: true }], quoteVerbatim: true, status: "cited" },
          { text: "bad quote", citations: [{ id: "E2", verdict: { valid: true }, quote: "not in E2", quoteVerbatim: false }], quoteVerbatim: false, status: "quote-mismatch" },
          { text: "made up", citations: [{ id: "E9", verdict: { valid: false, reason: "unknown-evidence-id" }, quote: "made up", quoteVerbatim: false }], quoteVerbatim: null, status: "invalid-citation" },
        ],
      }),
    );
    expect(v.tone).toBe("withheld");
    expect(v.title).toBe("Answer withheld");
    expect(v.reasons).toEqual([
      "Claim 2: the quoted text is not in E2, the evidence it is attributed to.",
      "Claim 3: it cites E9, which was not among the evidence provided.",
      "Claim 4: it gives no evidence.",
      "The model's reply was not in the required format.",
    ]);
    expect(v.claims.map((c) => c.passed)).toEqual([true, false, false]);
    expect(v.claims[1]!.citations[0]).toMatchObject({ quote: "not in E2", quoteVerbatim: false });
    expect(v.claims[2]!.citations[0]).toMatchObject({ id: "E9", valid: false, evidence: null });
    expect(v.citedIds).toEqual(["E1", "E2"]);
  });

  it("distinguishes a refusal by the search from a refusal by the model", () => {
    const bySearch = describeAnswer(result({ status: "insufficient_evidence", evidence: [], stats: { ...result({}).stats, modelCalled: false } }));
    const byModel = describeAnswer(result({ status: "insufficient_evidence", missing: "no retry logic is shown" }));
    expect(bySearch.detail).toContain("the model was not asked");
    expect(byModel.detail).toContain("The model read the evidence");
    expect(byModel.missing).toBe("no retry logic is shown");
    expect([bySearch.tone, byModel.tone]).toEqual(["insufficient", "insufficient"]);
  });

  it.each([
    ["rate_limited", "rate limited"],
    ["timeout", "too long"],
    ["http", "could not be reached"],
    ["blocked", "declined"],
  ])("reports a provider failure (%s) as unavailable, keeps the evidence, and shows no claims", (kind, phrase) => {
    const v = describeAnswer(result({ status: "provider_error", reasons: [`model provider failed: ${kind}`] }));
    expect(v.tone).toBe("unavailable");
    expect(v.title).toContain(phrase);
    expect(v.claims).toEqual([]);
    expect(v.evidence).toHaveLength(2);
    expect(v.canRetry).toBe(true);
  });
});

describe("describeFailure", () => {
  it("words each failure for the place it happened and never shows a raw internal error", () => {
    expect(describeFailure(classifyFailure(404, { error: "repository or commit not found" }), "ingest").title).toBe("Repository or commit not found");
    expect(describeFailure(classifyFailure(413, { error: "Ingestion limit exceeded: compressed-bytes > 1" }), "ingest").title).toContain("too large");
    expect(describeFailure(classifyFailure(429, { code: "rate_limited", retryAfterSeconds: 10 }), "answer").detail).toContain("about 10 seconds");
    expect(describeFailure(classifyFailure(429, { code: "rate_limited", retryAfterSeconds: 600 }), "ingest").detail).toContain("about 10 minutes");
    expect(describeFailure(classifyFailure(503, { error: "x", code: "no_provider" }), "answer").canRetry).toBe(false);
    const cooldown = describeFailure(classifyFailure(503, { error: "x", code: "model_cooldown", retryAfterSeconds: 45 }), "answer");
    expect(cooldown).toMatchObject({ title: "The model is rate limited right now", canRetry: true });
    expect(cooldown.detail).toContain("about 45 seconds");
    expect(describeFailure(classifyFailure(503, { error: "x", code: "model_cooldown", retryAfterSeconds: 5 * 3600 }), "answer").detail).toContain("about 5 hours");
    const day = describeFailure(classifyFailure(429, { error: "x", code: "daily_limit", retryAfterSeconds: 7 * 3600 }), "answer");
    expect(day).toMatchObject({ title: "Daily answer limit reached", canRetry: false });
    expect(day.detail).toBe("This server has used its allowance of answers for today. Try again in about 7 hours.");
    expect(describeFailure(classifyFailure(429, { error: "x", code: "daily_limit" }), "answer").detail).toBe("This server has used its allowance of answers for today. Answers will return later.");
    const share = describeFailure(classifyFailure(429, { error: "x", code: "client_daily_limit", retryAfterSeconds: 20 * 3600 }), "answer");
    expect(share.title).toBe("Too many requests");
    expect(share.detail).toContain("about 20 hours");
    const server = describeFailure(classifyFailure(500, { error: "EACCES: open C:\\secret" }), "answer");
    expect(server.detail).not.toContain("EACCES");
    expect(describeFailure(classifyFailure(400, { error: "question is limited to 300 characters" }), "answer").detail).toBe("question is limited to 300 characters");
  });
});

describe("API client", () => {
  const stub = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));

  it("treats a 502 that carries a full result as data, so retrieved evidence is not lost", async () => {
    stub(502, result({ status: "provider_error", reasons: ["model provider failed: rate_limited"] }));
    const r = await askQuestion("a/b", "s", "q");
    expect(r.ok && r.data.status).toBe("provider_error");
  });

  it("carries the model's stated wait with a rate-limited result, and the card then names the time instead of 'a minute'", async () => {
    const limited = result({ status: "provider_error", reasons: ["model provider failed: rate_limited"] });
    const withHeader = (value: string | null) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(limited), { status: 429, headers: value === null ? {} : { "retry-after": value } })));

    withHeader("42");
    expect(await askQuestion("a/b", "s", "q")).toMatchObject({ ok: true, retryAfterSeconds: 42 });
    // Absent or unusable headers leave the result as it was: no wait is invented.
    for (const bad of [null, "", "0", "-5", "soon", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      withHeader(bad);
      const r = await askQuestion("a/b", "s", "q");
      expect(r.ok).toBe(true);
      expect(r).not.toHaveProperty("retryAfterSeconds");
    }

    const at = new Date(2026, 9, 8, 14, 32, 7).getTime();
    const named = describeAnswer(limited, at).detail;
    expect(named).toContain(`The model said to try again after ${retryTime(at)}.`);
    expect(retryTime(at)).toMatch(/32.07/);
    expect(named).not.toContain("in a minute");
    expect(named).toContain("The evidence below was still retrieved.");
    expect(describeAnswer(limited).detail).toContain("Try again in a minute.");
    expect(describeAnswer(limited, Number.NaN).detail).toContain("Try again in a minute.");
    // Only a rate limit names a time; other outcomes ignore it.
    expect(describeAnswer(result({ status: "provider_error", reasons: ["model provider failed: timeout"] }), at).detail).not.toContain("try again after");
    expect(describeAnswer(result({}), at)).toEqual(describeAnswer(result({})));
  });

  it("words what the application read from the index, apart from the model's claims, and marks a shortened quote", () => {
    const importers = { kind: "importers" as const, target: "HTTPError", files: [{ path: "src/a.ts", line: 1, source: true }, { path: "src/b.ts", line: 2, source: true }, { path: "test/a.test.ts", line: 1, source: false }] };
    const entries = { kind: "entries" as const, pkg: "shop", entries: [{ path: "lib/main.js", entryKind: "main" }, { path: "lib/cart.js", entryKind: "exports" }], manifest: "package.json" };
    expect(describeFact(importers)).toBe("The index lists 3 files importing HTTPError: 2 source files (src/a.ts, src/b.ts), and 1 file in tests, examples or docs.");
    expect(describeFact({ ...importers, files: [importers.files[2]!] })).toBe("The index lists 1 file importing HTTPError: 1 file in tests, examples or docs.");
    expect(describeFact(entries)).toBe("Entry points of the package shop, as the index resolved them: main: lib/main.js, exports: lib/cart.js. Its manifest is package.json.");
    const many = { ...importers, files: Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, line: 1, source: true })) };
    expect(describeFact(many)).toContain("src/f5.ts and 3 more");

    const v = describeAnswer(result({ indexFacts: [importers, entries] }));
    expect(v.facts).toHaveLength(2);
    expect(v.claims.map((c) => c.text).join(" ")).not.toContain("The index lists");
    // A result stored before facts existed, and a model that declined, both still render.
    expect(describeAnswer(result({})).facts).toEqual([]);
    expect(describeAnswer(result({ status: "insufficient_evidence", indexFacts: [importers] })).facts).toHaveLength(1);

    const trimmed = describeAnswer(result({ claims: [{ text: "t", status: "cited", quoteVerbatim: true, citations: [{ id: "E1", verdict: { valid: true }, quote: "q".repeat(50), quoteVerbatim: true, quoteTrimmed: true }] }] }));
    expect(trimmed.claims[0]!.citations[0]!.quoteTrimmed).toBe(true);
    expect(describeAnswer(result({ claims: [{ text: "t", status: "cited", quoteVerbatim: true, citations: [{ id: "E1", verdict: { valid: true }, quote: "q".repeat(50), quoteVerbatim: true }] }] })).claims[0]!.citations[0]!.quoteTrimmed).toBe(false);
  });

  it("treats a 429 that carries a full result as data too, but this server's own 429 as a failure", async () => {
    stub(429, result({ status: "provider_error", reasons: ["model provider failed: rate_limited"] }));
    const fromModel = await askQuestion("a/b", "s", "q");
    expect(fromModel.ok && fromModel.data.status).toBe("provider_error");

    stub(429, { error: "Too many requests. Wait a moment and try again.", code: "rate_limited", retryAfterSeconds: 10 });
    expect(await askQuestion("a/b", "s", "q")).toMatchObject({ ok: false, kind: "rate_limited", retryAfterSeconds: 10 });
    stub(429, { error: "This server has reached its daily limit for answers. Try again later.", code: "daily_limit", retryAfterSeconds: 3600 });
    expect(await askQuestion("a/b", "s", "q")).toMatchObject({ ok: false, kind: "daily_limit" });
  });

  it("sends the question as JSON to the answer route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result({})), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await askQuestion("a/b", "c".repeat(40), "where is x?");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/answer");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "a/b", sha: "c".repeat(40), question: "where is x?" });
  });

  it("rejects a 200 whose body is not what the route promises", async () => {
    stub(200, { hello: "world" });
    expect((await ingestRepository("a/b", null)).ok).toBe(false);
    stub(200, "<html>proxy error</html>");
    expect((await fetchSource("a/b", "s", "p.ts", 1, 2)).ok).toBe(false);
  });

  it("reports a network failure and a cancelled request as different things", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await ingestRepository("a/b", null)).toMatchObject({ ok: false, kind: "network" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    expect(await ingestRepository("a/b", null)).toMatchObject({ ok: false, kind: "aborted" });
  });

  it("asks for a source excerpt once and serves it from memory afterwards, without remembering failures", async () => {
    const excerpt = { path: "src/once.ts", startLine: 1, endLine: 2, lineCount: 9, lines: ["a", "b"], truncatedLines: 0, url: "https://github.com/a/b/blob/s/src/once.ts#L1-L2" };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503 })).mockImplementation(async () => new Response(JSON.stringify(excerpt)));
    vi.stubGlobal("fetch", fetchMock);
    expect(rememberedSource("a/b", "s", "src/once.ts", 1, 2)).toBeNull();
    expect((await fetchSource("a/b", "s", "src/once.ts", 1, 2)).ok).toBe(false);
    expect(rememberedSource("a/b", "s", "src/once.ts", 1, 2)).toBeNull();
    expect((await fetchSource("a/b", "s", "src/once.ts", 1, 2)).ok).toBe(true);
    expect((await fetchSource("a/b", "s", "src/once.ts", 1, 2)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rememberedSource("a/b", "s", "src/once.ts", 1, 2)).toEqual(excerpt);
    expect(rememberedSource("a/b", "s", "src/once.ts", 1, 3)).toBeNull();
  });

  it("encodes source parameters rather than splicing them into the address", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSource("a/b", "s", "src/a b&x=1.ts", 3, 9);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/source?repo=a%2Fb&sha=s&path=src%2Fa+b%26x%3D1.ts&start=3&end=9");
  });
});

describe("githubUrl", () => {
  it("lets only github.com links through", () => {
    expect(githubUrl("https://github.com/a/b/blob/s/x.ts#L1-L2")).toBe("https://github.com/a/b/blob/s/x.ts#L1-L2");
    for (const bad of ["javascript:alert(1)", "http://github.com/a", "https://github.com.evil.example/a", "//github.com/a", "", null, undefined]) expect(githubUrl(bad)).toBeNull();
  });
});

describe("stored recent repositories", () => {
  const sha = "a".repeat(40);
  const entry = (owner: string, repo: string) => ({ owner, repo, sha, files: 3, openedAt: 1 });

  it("keeps well-formed entries and drops one whose owner or repo could not have been typed", async () => {
    const { parseRecents } = await import("./store");
    const good = entry("sindresorhus", "slugify");
    const bad = [entry("evil/..", "x"), entry("a", "b/c"), entry("a b", "c"), entry("a", "..")];
    expect(parseRecents(JSON.stringify([good, ...bad]))).toEqual([good]);
  });
});

describe("short quotes", () => {
  it("flags a quote too short to identify a place, and not a normal one", async () => {
    const { isShortQuote } = await import("./answer-view");
    for (const q of ["/**", "return", "=>", "  the  "]) expect(isShortQuote(q)).toBe(true);
    expect(isShortQuote("const retryDelay = Math.min(")).toBe(false);
    expect(isShortQuote("@default '-'")).toBe(true);
  });
});
