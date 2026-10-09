import { afterEach, describe, expect, it, vi } from "vitest";
import { describeResponse, withEventLog } from "./log-event";

afterEach(() => vi.restoreAllMocks());

describe("describeResponse", () => {
  it("names each failure so one can be told from another", () => {
    const answer = (status: number, body: unknown) => describeResponse("answer", status, body, 12.4);
    expect(answer(502, { status: "provider_error", reasons: ["model provider failed: rate_limited"], rejections: [], stats: { modelCalled: true, inputTokens: 3700, outputTokens: 0, modelMs: 2300.6 } })).toEqual({
      route: "answer", status: 502, outcome: "provider_error", cause: "rate_limited", modelCalled: true, inputTokens: 3700, outputTokens: 0, modelMs: 2301, ms: 12,
    });
    expect(answer(200, { status: "rejected", reasons: ["x"], rejections: [{ code: "quote-too-long" }], stats: { modelCalled: true } })).toMatchObject({ outcome: "rejected", cause: "quote-too-long" });
    expect(answer(200, { status: "insufficient_evidence", reasons: [], rejections: [], stats: { modelCalled: false } })).toMatchObject({ outcome: "insufficient_evidence", modelCalled: false });
    expect(answer(503, { error: "source rate limited; retry later", code: "source_rate_limited" })).toMatchObject({ outcome: "source_rate_limited" });
    expect(answer(429, { error: "slow down", code: "daily_limit" })).toMatchObject({ outcome: "daily_limit" });
    expect(answer(415, { error: "content-type must be application/json" })).toMatchObject({ outcome: "http_415" });
    expect(describeResponse("ingest", 200, { sha: "a", files: 12, chunks: 40, cached: true }, 5)).toMatchObject({ outcome: "ingested", files: 12, cached: true });
  });

  it("drops anything that is not a short plain token, so free text cannot reach the log", () => {
    const e = describeResponse("answer", 400, { error: "x", code: "has spaces and a question?" }, 1);
    expect(e.outcome).toBe("http_400");
  });
});

describe("withEventLog", () => {
  it("returns the response untouched and writes one line without the question, a prompt or a key", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const secret = "gsk_SECRET-KEY-VALUE";
    const handler = async () => Response.json({ status: "answered", claims: [{ text: "SECRET-CLAIM-TEXT " + secret }], reasons: [], rejections: [], stats: { modelCalled: true, inputTokens: 10, outputTokens: 2, modelMs: 5 } });
    const res = await withEventLog("answer", handler)();
    expect((await res.json()).status).toBe("answered");
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ route: "answer", status: 200, outcome: "answered", modelCalled: true, inputTokens: 10 });
    for (const leak of ["SECRET-CLAIM-TEXT", secret]) expect(line).not.toContain(leak);
  });

  it("never changes a response when the body cannot be read", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const res = await withEventLog("ingest", async () => new Response("not json", { status: 500 }))();
    expect(res.status).toBe(500);
    expect(JSON.parse(String(info.mock.calls[0]![0]))).toMatchObject({ outcome: "http_500" });
  });
});
