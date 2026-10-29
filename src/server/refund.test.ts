import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILES, TEST_REPO, buildFixture } from "../answer/test-helpers";
import { enter, isRefusal, nextStepsEnabled, resetGuards } from "./guards";
import { handleAnswer } from "./answer-handler";

const gh = vi.hoisted(() => ({ fetchRepoInfo: vi.fn(), resolveCommitSha: vi.fn(), githubFetch: vi.fn() }));
vi.mock("../github/client", async (orig) => ({ ...(await orig<typeof import("../github/client")>()), ...gh }));

const { POST: answer } = await import("../app/api/answer/route");
const { LocalFsStore } = await import("../index/store");
const { serializeIndex } = await import("../index/serialize");

const CLIENT = { "x-forwarded-for": "198.51.100.30" };
const ANSWERABLE = "where is loginUser implemented";
// English-looking words that the fixture does not contain: refused by the policy before the model (a gibberish string would be taken for
// another language and cost the small keyword-translation call first).
const UNMATCHED = "How does the kubernetes helm chart handle blue green rollback";
const INSUFFICIENT = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"status":"insufficient_evidence","missing":"x"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

let storeDir: string;
let clock = 0;
beforeEach(async () => {
  clock = 0;
  resetGuards(() => clock);
  storeDir = mkdtempSync(path.join(tmpdir(), "refund-store-"));
  vi.stubEnv("INDEX_STORE_DIR", storeDir);
  vi.stubEnv("INDEX_STORE_URL", "");
  vi.stubEnv("TRUST_PROXY", "1");
  vi.stubEnv("GROQ_API_KEY", "test-key");
  vi.stubEnv("GROQ_MODEL", "test-model");
  const { index } = await buildFixture(FILES);
  await new LocalFsStore(storeDir).put(TEST_REPO, serializeIndex(index.artifact).bytes);
  gh.githubFetch.mockImplementation(async (url: URL | string) => {
    const file = Object.keys(FILES).find((p) => String(url).includes(`/contents/${p}`));
    return file ? new Response(FILES[file as keyof typeof FILES]) : new Response("", { status: 404 });
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The route with the model's HTTP reply supplied here; `ask` sends one question as the given client. */
function withModel(reply: () => Response = INSUFFICIENT) {
  const model = vi.fn().mockImplementation(async () => reply());
  vi.stubGlobal("fetch", model);
  const ask = (question: string, headers: Record<string, string> = CLIENT) =>
    answer(new NextRequest("http://localhost/api/answer", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ repo: "acme/shop", sha: TEST_REPO.sha, question }) }));
  return { model, ask };
}

describe("W-13 (e): a refusal that cost no model call gives back the per-minute allowance", () => {
  it("flag ON: unmatched questions never use the allowance, so the next question is accepted at once", async () => {
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const { model, ask } = withModel();
    for (let i = 0; i < 4; i++) {
      const res = await ask(UNMATCHED);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "insufficient_evidence", stats: { modelCalled: false } });
      expect(body.nextSteps.suggestions.length).toBeGreaterThanOrEqual(1);
    }
    expect(model).not.toHaveBeenCalled();
    // The question that follows the refusals is still allowed: the allowance is one per client per two minutes.
    expect((await ask(ANSWERABLE)).status).toBe(200);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("flag OFF: the same refusal uses the allowance, so the next question has to wait (today's behaviour, unchanged)", async () => {
    const { model, ask } = withModel();
    const first = await ask(UNMATCHED);
    expect(first.status).toBe(200);
    expect(await first.json()).not.toHaveProperty("nextSteps");
    const next = await ask(ANSWERABLE);
    expect(next.status).toBe(429);
    expect(await next.json()).toMatchObject({ code: "rate_limited" });
    expect(model).not.toHaveBeenCalled();
  });

  it("a flag value other than exactly 1 is OFF", async () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      vi.stubEnv("QUALITY_NEXT_STEPS", v);
      expect(nextStepsEnabled()).toBe(false);
    }
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    expect(nextStepsEnabled()).toBe(true);
  });

  it("flag ON: two answered questions in a row are still limited, and a request that reached the model is not refunded", async () => {
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const { model, ask } = withModel();
    expect((await ask(ANSWERABLE)).status).toBe(200); // reached the model (it replied insufficient_evidence)
    expect(model).toHaveBeenCalledTimes(1);
    const second = await ask(ANSWERABLE);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "rate_limited", guidance: "wait" });
    // A refusal from the model itself is also a call that was made, so it is not given back either.
    const third = await ask(UNMATCHED);
    expect(third.status).toBe(429);
    expect(model).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000;
    expect((await ask(ANSWERABLE)).status).toBe(200);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("flag ON: the refund also gives the global allowance back, so refusals do not use up the server's two questions", async () => {
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const { ask } = withModel();
    for (let i = 0; i < 5; i++) expect((await ask(UNMATCHED, { "x-forwarded-for": `198.51.100.${40 + i}` })).status).toBe(200);
    expect((await ask(ANSWERABLE, { "x-forwarded-for": "198.51.100.50" })).status).toBe(200);
  });

  it("resetGuards() empties every counter", async () => {
    const { ask } = withModel();
    expect((await ask(ANSWERABLE)).status).toBe(200);
    expect((await ask(ANSWERABLE)).status).toBe(429);
    resetGuards(() => clock);
    expect((await ask(ANSWERABLE)).status).toBe(200);
  });
});

describe("W-13 (h): the keyword-translation call of a non-English question is a model call and is not refunded", () => {
  // Accented letters make the question look non-English, so the small keyword call is made first; no word matches the fixture, so the policy then refuses.
  const FOREIGN = "Çfarë bën kubernetes helm për rikthimin blue green";
  const KEYWORDS = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"keywords":["kubernetes","helm"]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

  it("flag ON: stats.expansionCalled is true, the per-minute allowance is kept, so the next question has to wait", async () => {
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const { model, ask } = withModel(KEYWORDS);
    const first = await ask(FOREIGN);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ status: "insufficient_evidence", stats: { modelCalled: false, expansionCalled: true } });
    expect(model).toHaveBeenCalledTimes(1);
    const next = await ask(ANSWERABLE);
    expect(next.status).toBe(429);
    expect(await next.json()).toMatchObject({ code: "rate_limited", guidance: "wait" });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("flag ON: an English refusal still has expansionCalled false and is refunded as before", async () => {
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const { model, ask } = withModel(KEYWORDS);
    const body = await (await ask(UNMATCHED)).json();
    expect(body.stats.expansionCalled).toBe(false);
    expect(model).not.toHaveBeenCalled();
    expect((await ask(ANSWERABLE)).status).toBe(200);
  });

  it("flag OFF: the key is absent and the behaviour is the old one", async () => {
    const { ask } = withModel(KEYWORDS);
    const body = await (await ask(FOREIGN)).json();
    expect(body.stats).not.toHaveProperty("expansionCalled");
    expect((await ask(ANSWERABLE)).status).toBe(429);
  });
});

describe("W-13 (f): guidance markers on failure bodies, only with the flag ON", () => {
  const PLAIN = (code: string, error: string, retry: number) => JSON.stringify({ error, code, retryAfterSeconds: retry });

  it("per-client 429 says wait; JSON is the old body byte for byte with the flag OFF", async () => {
    for (const on of [false, true]) {
      resetGuards(() => clock);
      vi.stubEnv("QUALITY_NEXT_STEPS", on ? "1" : "");
      const { ask } = withModel();
      await ask(ANSWERABLE);
      const res = await ask(ANSWERABLE);
      expect(res.status).toBe(429);
      const text = await res.text();
      const base = PLAIN("rate_limited", "Too many requests. Wait a moment and try again.", 120);
      expect(text).toBe(on ? base.replace(/}$/, ',"guidance":"wait"}') : base);
    }
  });

  it("global 429 says busy", async () => {
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const { ask } = withModel();
    expect((await ask(ANSWERABLE, { "x-forwarded-for": "198.51.100.61" })).status).toBe(200);
    expect((await ask(ANSWERABLE, { "x-forwarded-for": "198.51.100.62" })).status).toBe(200);
    const res = await ask(ANSWERABLE, { "x-forwarded-for": "198.51.100.63" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited", guidance: "busy" });
  });

  it("503 model_cooldown says busy, and has no marker with the flag OFF", async () => {
    for (const on of [false, true]) {
      resetGuards(() => clock);
      vi.stubEnv("QUALITY_NEXT_STEPS", on ? "1" : "");
      const { ask } = withModel(() => new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "30" } }));
      await ask(ANSWERABLE);
      const res = await ask(ANSWERABLE, { "x-forwarded-for": "198.51.100.77" });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ code: "model_cooldown" });
      expect("guidance" in body).toBe(on);
      if (on) expect(body.guidance).toBe("busy");
    }
  });

  it("503 busy (all slots taken) says busy only with the flag ON", () => {
    for (const on of [false, true]) {
      resetGuards(() => clock);
      vi.stubEnv("QUALITY_NEXT_STEPS", on ? "1" : "");
      const first = enter("answer");
      expect(isRefusal(first)).toBe(false);
      const second = enter("answer");
      expect(isRefusal(second)).toBe(true);
      if (isRefusal(second)) {
        expect(second.status).toBe(503);
        expect(JSON.stringify(second.body)).toBe(on ? PLAIN("busy", "The server is busy with other requests. Try again in a few seconds.", 5).replace(/}$/, ',"guidance":"busy"}') : PLAIN("busy", "The server is busy with other requests. Try again in a few seconds.", 5));
      }
      if (typeof first === "function") first();
    }
  });

  it("the 500 body says error with the flag ON and is exactly {\"error\":\"internal error\"} with it OFF", async () => {
    const body = { repo: "acme/shop", sha: TEST_REPO.sha, question: ANSWERABLE };
    const deps = { provider: { name: "x", complete: async () => "" }, loadIndex: async () => { throw new Error("boom"); }, makeSource: () => ({ getFile: async () => null }) };
    vi.stubEnv("QUALITY_NEXT_STEPS", "");
    const off = await handleAnswer(deps, body);
    expect(off.status).toBe(500);
    expect(JSON.stringify(off.body)).toBe('{"error":"internal error"}');
    vi.stubEnv("QUALITY_NEXT_STEPS", "1");
    const on = await handleAnswer(deps, body);
    expect(on.status).toBe(500);
    expect(JSON.stringify(on.body)).toBe('{"error":"internal error","guidance":"error"}');
  });
});
