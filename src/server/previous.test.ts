import { afterEach, describe, expect, it } from "vitest";
import { FILES, ScriptedModel, TEST_REPO, buildFixture } from "../answer/test-helpers";
import { handleAnswer } from "./answer-handler";

const REFUSE = JSON.stringify({ status: "insufficient_evidence", missing: "scripted" });
const base = { repo: "acme/shop", sha: TEST_REPO.sha };
const previous = { question: "where is loginUser implemented", outcome: "answered", files: [{ path: "src/auth/login.ts", startLine: 3, endLine: 6 }] };

type Body = Record<string, unknown> & { stats?: Record<string, unknown> };
async function call(question: string, extra: Record<string, unknown> = {}) {
  const { index, source } = await buildFixture(FILES);
  const provider = new ScriptedModel(REFUSE);
  const res = await handleAnswer({ provider, loadIndex: async () => index, makeSource: () => source }, { ...base, question, ...extra });
  const body = res.body as Body;
  // Timings differ run to run; everything else must match exactly.
  const stable = body.stats ? { ...body, stats: { ...body.stats, retrievalMs: 0, sourceMs: 0, modelMs: 0, validateMs: 0 } } : body;
  return { res, body, stable, provider };
}

const saved = process.env.QUALITY_FOLLOWUP_CONTEXT;
afterEach(() => {
  if (saved === undefined) delete process.env.QUALITY_FOLLOWUP_CONTEXT;
  else process.env.QUALITY_FOLLOWUP_CONTEXT = saved;
});

describe("QUALITY_FOLLOWUP_CONTEXT is read per request and is ON only for exactly 1", () => {
  it.each(["true", "yes", "0", "", " 1", "11"])("value %j leaves the feature off", async (value) => {
    process.env.QUALITY_FOLLOWUP_CONTEXT = value;
    const { body } = await call("how does that work?", { previous });
    expect("followup" in body).toBe(false);
  });

  it("(b) with the flag off a request with `previous` is answered exactly as one without it", async () => {
    delete process.env.QUALITY_FOLLOWUP_CONTEXT;
    const without = await call("how does that work?");
    const withPrevious = await call("how does that work?", { previous });
    expect(withPrevious.res.status).toBe(without.res.status);
    expect(withPrevious.stable).toEqual(without.stable);
    expect(withPrevious.provider.requests.length).toBe(without.provider.requests.length);
    expect(JSON.stringify(withPrevious.stable)).not.toContain("followup");
  });

  it("(i) a request without `previous` is answered the same with the flag on as off", async () => {
    for (const q of ["where is loginUser implemented", "where is chargeCustomer defined", "what is the weather in tirana"]) {
      delete process.env.QUALITY_FOLLOWUP_CONTEXT;
      const off = await call(q);
      process.env.QUALITY_FOLLOWUP_CONTEXT = "1";
      const on = await call(q);
      expect(on.res.status).toBe(off.res.status);
      expect(on.stable, q).toEqual(off.stable);
      expect(on.provider.requests.length).toBe(off.provider.requests.length);
    }
  });
});

describe("with the flag on", () => {
  it("a follow-up carries the previous turn's topic and says so", async () => {
    process.env.QUALITY_FOLLOWUP_CONTEXT = "1";
    const { res, body, provider } = await call("how does that work?", { previous });
    expect(res.status).toBe(200);
    expect(body.followup).toEqual({ inherited: true, from: "where is loginUser implemented" });
    expect((body.evidence as { path: string }[])[0]?.path).toBe("src/auth/login.ts");
    const sent = provider.requests.map((r) => `${r.system}\n${r.user}`).join("\n");
    expect(sent).not.toContain("where is loginUser implemented");
  });

  it("(a) a hostile or malformed `previous` is ignored, never an error, and the answer is the one without it", async () => {
    process.env.QUALITY_FOLLOWUP_CONTEXT = "1";
    // A pointing question is the one that would use `previous`, so it shows whether the hostile value was really ignored.
    const plain = await call("how does that work?");
    const ignored: unknown[] = [null, 7, "previous", [], { question: 5 }, { question: "q", outcome: "x" }, { question: "   ", outcome: "answered" }, { outcome: "answered" }, { question: "q" }];
    for (const h of ignored) {
      const r = await call("how does that work?", { previous: h });
      expect(r.res.status, JSON.stringify(h)).toBe(200);
      expect(r.stable, JSON.stringify(h)).toEqual(plain.stable);
    }
    // Well-formed on the outside but hostile inside: accepted at most as words, never an error, nothing invented reaches the answer.
    const bounded: unknown[] = [{ question: "x".repeat(100_000), outcome: "answered", files: "no" }, { question: "q", outcome: "answered", files: [{ path: "../../etc/passwd", startLine: -1, endLine: 1e99 }, { path: "src/evil/SECRET-PATH-88.ts", startLine: 1, endLine: 2 }] }, JSON.parse('{"__proto__":{"a":1},"question":"q","outcome":"answered"}')];
    for (const h of bounded) {
      const r = await call("how does that work?", { previous: h });
      expect(r.res.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain("SECRET-PATH-88");
      expect(JSON.stringify(r.body)).not.toContain("etc/passwd");
      expect(((r.body.followup as { from?: string } | undefined)?.from ?? "").length).toBeLessThanOrEqual(120);
      for (const e of (r.body.evidence as { path: string }[])) expect(Object.keys(FILES)).toContain(e.path);
    }
  });

  it("(e) a follow-up with nothing to point at is a clarifying question and calls no model", async () => {
    process.env.QUALITY_FOLLOWUP_CONTEXT = "1";
    for (const extra of [{}, { previous: { question: "does it support graphql", outcome: "refused", files: [] } }]) {
      const { res, body, provider } = await call("ok then what about the other one?", extra);
      expect(res.status).toBe(200);
      expect(body.status).toBe("insufficient_evidence");
      expect((body.nextSteps as { kind: string }).kind).toBe("clarify");
      expect(body.followup).toEqual({ inherited: false });
      expect(provider.requests).toHaveLength(0);
    }
  });

  it("existing validation errors and messages are unchanged", async () => {
    process.env.QUALITY_FOLLOWUP_CONTEXT = "1";
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel(REFUSE);
    const res = await handleAnswer({ provider, loadIndex: async () => index, makeSource: () => source }, { ...base, question: "  ", previous });
    expect(res).toEqual({ status: 400, body: { error: "repo, sha and question are required strings" } });
    const long = await handleAnswer({ provider, loadIndex: async () => index, makeSource: () => source }, { ...base, question: "x".repeat(301), previous });
    expect(long).toEqual({ status: 400, body: { error: "question is limited to 300 characters" } });
  });
});
