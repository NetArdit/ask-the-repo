import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqProvider, parseDurationMs, type ModelRequest } from "./provider";

afterEach(() => vi.unstubAllGlobals());

const KEY = "gsk_test_secret_value_123";
const REQ: ModelRequest = { system: "sys", user: "usr", maxTokens: 50, nonce: "n" };
const SIGNAL = () => AbortSignal.timeout(5000);
const okBody = JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const ok = (headers: Record<string, string> = {}) => new Response(okBody, { headers });
const limited = (headers: Record<string, string> = {}) => new Response(`quota body mentioning ${KEY}`, { status: 429, headers });

function make(rateLimit?: { maxRetries: number; maxWaitMs: number }, clock = { t: 0 }) {
  const sleeps: number[] = [];
  const provider = new GroqProvider({
    apiKey: KEY,
    model: "m",
    ...(rateLimit ? { rateLimit } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
  });
  return { provider, sleeps, clock };
}

describe("parseDurationMs", () => {
  it.each([
    ["690ms", 690],
    ["7.66s", 7660],
    ["2m52.8s", 172800],
    ["1h2m3s", 3723000],
  ])("parses %s", (text, ms) => expect(parseDurationMs(text)).toBe(ms));
  it("returns null for nothing parseable", () => {
    expect(parseDurationMs(null)).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
  });
});

describe("GroqProvider rate limiting (stubbed fetch and clock; no real model was called)", () => {
  it("waits for Retry-After on a 429 and then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited({ "retry-after": "2" })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const { provider, sleeps } = make({ maxRetries: 3, maxWaitMs: 60_000 });
    expect(await provider.complete(REQ, SIGNAL())).toBe("{}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2250]);
  });

  it("falls back to the token-reset header, then to exponential backoff, when Retry-After is absent", async () => {
    const a = vi.fn().mockResolvedValueOnce(limited({ "x-ratelimit-reset-tokens": "7.5s" })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", a);
    const first = make({ maxRetries: 3, maxWaitMs: 60_000 });
    await first.provider.complete(REQ, SIGNAL());
    expect(first.sleeps).toEqual([7750]);
    const b = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", b);
    const second = make({ maxRetries: 3, maxWaitMs: 60_000 });
    await second.provider.complete(REQ, SIGNAL());
    expect(second.sleeps).toEqual([2250, 4250]);
  });

  it("retries a bounded number of times and then fails as rate_limited", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => limited({ "retry-after": "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { provider, sleeps } = make({ maxRetries: 2, maxWaitMs: 60_000 });
    const err = await provider.complete(REQ, SIGNAL()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rate_limited", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not sleep through a quota window longer than the wait cap", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => limited({ "retry-after": "7200" }));
    vi.stubGlobal("fetch", fetchMock);
    const { provider, sleeps } = make({ maxRetries: 4, maxWaitMs: 180_000 });
    const err = await provider.complete(REQ, SIGNAL()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterMs: 7_200_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("fails fast with rate_limited, without sleeping, when rate limiting is not enabled (the web route)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(limited({ "retry-after": "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { provider, sleeps } = make();
    await expect(provider.complete(REQ, SIGNAL())).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it.each([400, 401, 403, 404, 500])("does not retry a non-retryable HTTP %i", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const { provider, sleeps } = make({ maxRetries: 4, maxWaitMs: 60_000 });
    await expect(provider.complete(REQ, SIGNAL())).rejects.toMatchObject({ kind: "http", status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("paces from the reported token bucket instead of a fixed delay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ "x-ratelimit-remaining-tokens": "1000", "x-ratelimit-limit-tokens": "8000" }))
      .mockImplementation(async () => ok({ "x-ratelimit-remaining-tokens": "7000", "x-ratelimit-limit-tokens": "8000" }));
    vi.stubGlobal("fetch", fetchMock);
    const { provider, sleeps, clock } = make({ maxRetries: 2, maxWaitMs: 60_000 });
    const big: ModelRequest = { ...REQ, user: "x".repeat(19_997) }; // 5000 prompt + 1000 expected output = 6000 tokens
    await provider.complete(big, SIGNAL());
    expect(sleeps).toEqual([]); // nothing reported yet, so the first call is not delayed
    await provider.complete(big, SIGNAL());
    expect(sleeps).toEqual([37_750]); // (6000 - 1000) tokens at 8000/min = 37.5 s, plus margin
    sleeps.length = 0;
    clock.t += 60_000; // a full minute later the bucket is refilled
    await provider.complete(big, SIGNAL());
    expect(sleeps).toEqual([]);
  });

  it("never leaks the key through errors or a quota response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => limited({ "retry-after": "1" })));
    const { provider } = make({ maxRetries: 1, maxWaitMs: 60_000 });
    const err = await provider.complete(REQ, SIGNAL()).catch((e: unknown) => e);
    expect(String(err)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
});

describe("rate-limit observation", () => {
  const message = "Rate limit reached for model `m` in organization `org_PRIVATE` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199500, Requested 4000. Please try again in 3m.";
  const body = JSON.stringify({ error: { message, type: "tokens", code: "rate_limit_exceeded" } });
  const real429 = () =>
    new Response(body, {
      status: 429,
      headers: { "retry-after": "7200", "x-ratelimit-remaining-tokens": "500", "x-ratelimit-reset-tokens": "2m1s", "set-cookie": "session=SECRET-COOKIE", "x-request-id": "req_private" },
    });

  it("keeps only the whitelisted headers, the error type/code and the limit sentence, and nothing secret or identifying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => real429()));
    const { provider } = make();
    const err = (await provider.complete(REQ, SIGNAL()).catch((e: unknown) => e)) as { rateLimit: unknown; message: string };
    expect(err.rateLimit).toEqual({
      status: 429,
      headers: { "retry-after": "7200", "x-ratelimit-remaining-tokens": "500", "x-ratelimit-reset-tokens": "2m1s" },
      errorType: "tokens",
      errorCode: "rate_limit_exceeded",
      limitFragment: "tokens per day (TPD): Limit 200000, Used 199500, Requested 4000",
    });
    const text = JSON.stringify(err.rateLimit) + err.message;
    for (const leak of [KEY, "org_PRIVATE", "SECRET-COOKIE", "req_private"]) expect(text).not.toContain(leak);
  });

  it("records nothing extra when the response is not the expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => limited()));
    const { provider } = make();
    const err = (await provider.complete(REQ, SIGNAL()).catch((e: unknown) => e)) as { rateLimit: unknown };
    expect(err.rateLimit).toEqual({ status: 429, headers: {} });
  });

  it("sends exactly the request it sent before observation existed", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { provider } = make();
    await provider.complete(REQ, SIGNAL());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${KEY}` });
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: "usr" }], max_tokens: 4096, temperature: 0, response_format: { type: "json_object" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
