import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, checkRate, enter, isRefusal, refundDailyAnswer, refundRate, resetGuards, startModelCooldown } from "./guards";
import { BodyTooLargeError, ConcurrencyGate, RateLimiter, WindowCounter, readJsonBody } from "./limits";

afterEach(() => {
  vi.unstubAllEnvs();
  resetGuards();
});

describe("RateLimiter", () => {
  it("allows the capacity, then refuses with the time until the next request, then refills", () => {
    let t = 0;
    const rl = new RateLimiter(3, 60_000, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")].every((d) => d.ok)).toBe(true);
    const refused = rl.take("a");
    expect(refused).toEqual({ ok: false, retryAfterMs: 20_000 });
    t += 19_999;
    expect(rl.take("a").ok).toBe(false);
    t += 1;
    expect(rl.take("a").ok).toBe(true);
    t += 600_000;
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")].map((d) => d.ok)).toEqual([true, true, true, false]);
  });

  it("counts keys separately and gives a request back on refund", () => {
    const rl = new RateLimiter(1, 60_000, () => 0);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("b").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    rl.refund("a");
    expect(rl.take("a").ok).toBe(true);
  });

  it("never tracks more keys than its bound, however many distinct clients appear", () => {
    const rl = new RateLimiter(2, 60_000, () => 0, 100);
    for (let i = 0; i < 5000; i++) rl.take(`client-${i}`);
    expect(rl.trackedKeys).toBe(100);
  });
});

describe("ConcurrencyGate", () => {
  it("turns callers away at the cap and admits again after a release, tolerating a double release", () => {
    const gate = new ConcurrencyGate(2);
    const a = gate.tryEnter()!;
    const b = gate.tryEnter()!;
    expect(gate.tryEnter()).toBeNull();
    a();
    a();
    expect(gate.inFlight).toBe(1);
    expect(gate.tryEnter()).not.toBeNull();
    b();
  });
});

describe("readJsonBody", () => {
  const stream = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });

  it("parses a small body and returns null for invalid JSON", async () => {
    expect(await readJsonBody(new Request("http://x", { method: "POST", body: '{"a":1}' }), 100)).toEqual({ a: 1 });
    expect(await readJsonBody(new Request("http://x", { method: "POST", body: "not json" }), 100)).toBeNull();
    expect(await readJsonBody(new Request("http://x", { method: "POST" }), 100)).toBeNull();
  });

  it("refuses from the declared length without reading", async () => {
    const req = new Request("http://x", { method: "POST", body: "x".repeat(500), headers: { "content-length": "500" } });
    await expect(readJsonBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("stops reading a streamed body with no declared length once it passes the limit", async () => {
    const req = new Request("http://x", { method: "POST", body: stream(Array.from({ length: 50 }, () => "y".repeat(1000))), duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readJsonBody(req, 4096)).rejects.toMatchObject({ limitBytes: 4096 });
  });
});

describe("WindowCounter", () => {
  it("is a hard ceiling: nothing comes back until the window that opened at the first request has passed", () => {
    let t = 1000;
    const day = new WindowCounter(3, 86_400_000, () => t);
    expect([day.take(), day.take(), day.take()].every((d) => d.ok)).toBe(true);
    t += 43_200_000; // half a day later a token bucket would have refilled half; this must not
    expect(day.take()).toEqual({ ok: false, retryAfterMs: 43_200_000 });
    day.refund();
    expect(day.take().ok).toBe(true);
    t += 43_200_000;
    expect([day.take(), day.take(), day.take(), day.take()].map((d) => d.ok)).toEqual([true, true, true, false]);
  });
});

describe("request guards", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api", { headers });
  const from = (ip: string) => req({ "x-forwarded-for": ip });

  it("without a trusted proxy callers cannot be told apart, so only the global limit applies, per route", () => {
    let t = 0;
    resetGuards(() => t);
    expect(clientKey(from("203.0.113.9"))).toBeNull();
    // Two in a burst, then one a minute.
    for (let i = 0; i < 2; i++) expect(checkRate("answer", req())).toBeNull();
    const refused = checkRate("answer", req())!;
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    expect(refused.headers["Retry-After"]).toBe("60");
    expect(checkRate("read", req())).toBeNull(); // a different route is unaffected
    t += 60_000;
    expect(checkRate("answer", req())).toBeNull();
    expect(checkRate("answer", req())?.status).toBe(429);
  });

  it("with a trusted proxy, believes the address the proxy appended and not the one the client claimed", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(clientKey(from("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(from("1.2.3.4, 198.51.100.7"))).toBe("198.51.100.7");
    expect(clientKey(from("<script>"))).toBeNull();
    expect(clientKey(req())).toBeNull();
  });

  it("a client that invents a new forwarded address on every request still shares one allowance", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    resetGuards(() => 0);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(checkRate("answer", from(`10.9.8.${i}, 198.51.100.7`))?.status ?? 200);
    expect(statuses).toEqual([200, 429, 429, 429]);
  });

  it("with a trusted proxy, one client cannot use up another's allowance, and the global limit still holds", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    resetGuards(() => 0);
    expect(checkRate("answer", from("198.51.100.1"))).toBeNull();
    expect(checkRate("answer", from("198.51.100.1"))?.status).toBe(429);
    expect(checkRate("answer", from("198.51.100.2"))).toBeNull();
    // Two in a burst in total: both are used, so a third client is refused by the global limit, not its own.
    expect(checkRate("answer", from("192.0.2.200"))!.body.code).toBe("rate_limited");
  });

  it("gives an identified client a share of the day's answers, counted apart from other clients and refundable", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    let t = 0;
    resetGuards(() => t);
    const mine = from("198.51.100.1");
    for (let i = 0; i < 8; i++) {
      expect(checkRate("answer", mine)).toBeNull();
      t += 2 * 60_000;
    }
    const share = checkRate("answer", mine)!;
    expect(share.status).toBe(429);
    expect(share.body.code).toBe("client_daily_limit");
    expect(share.body.retryAfterSeconds).toBe(24 * 3600 - 16 * 60);
    // The refusal took nothing: another client is served, and so is this one after a refund (a call the model turned away).
    expect(checkRate("answer", from("198.51.100.2"))).toBeNull();
    t += 2 * 60_000;
    refundDailyAnswer(mine);
    expect(checkRate("answer", mine)).toBeNull();
    t += 2 * 60_000;
    expect(checkRate("answer", mine)?.body.code).toBe("client_daily_limit");
  });

  it("stops asking the model for as long as it said to wait, and makes up no wait when it named none", () => {
    let t = 1_000_000;
    resetGuards(() => t);
    startModelCooldown(null);
    startModelCooldown(0);
    expect(checkRate("answer", req())).toBeNull();
    startModelCooldown(90_000);
    startModelCooldown(30_000); // a shorter wait does not cut a longer one short
    const paused = checkRate("answer", req())!;
    expect(paused.status).toBe(503);
    expect(paused.body).toMatchObject({ code: "model_cooldown", retryAfterSeconds: 90 });
    expect(paused.headers["Retry-After"]).toBe("90");
    expect(checkRate("read", req())).toBeNull(); // reading source and searching do not need the model
    expect(checkRate("ingest", req())).toBeNull();
    t += 89_000;
    expect(checkRate("answer", req())?.body.code).toBe("model_cooldown");
    t += 1_000;
    // The paused requests used none of the allowance, so the burst is still whole.
    expect(checkRate("answer", req())).toBeNull();
    expect(checkRate("answer", req())).toBeNull();
    // A wait of hours (a daily quota) is honoured in full.
    startModelCooldown(5 * 3_600_000);
    expect(checkRate("answer", req())!.body.retryAfterSeconds).toBe(5 * 3600);
  });

  it("enforces a real daily ceiling on answers, refundable when the model was never called", () => {
    vi.stubEnv("ANSWERS_PER_DAY", "2");
    let t = 0;
    resetGuards(() => t);
    expect(checkRate("answer", req())).toBeNull();
    t += 2 * 60_000;
    expect(checkRate("answer", req())).toBeNull();
    t += 2 * 60_000;
    const day = checkRate("answer", req())!;
    expect(day.body.code).toBe("daily_limit");
    expect(day.status).toBe(429);
    refundDailyAnswer();
    expect(checkRate("answer", req())).toBeNull();
    t += 12 * 3_600_000; // half a day later: still the same day's allowance
    expect(checkRate("answer", req())?.body.code).toBe("daily_limit");
    t += 12 * 3_600_000;
    expect(checkRate("answer", req())).toBeNull();
  });

  it("gives back the allowance of a request refused for its own shape", () => {
    resetGuards(() => 0);
    for (let i = 0; i < 24; i++) expect(checkRate("ingest", req())).toBeNull();
    expect(checkRate("ingest", req())?.status).toBe(429);
    refundRate("ingest", req());
    expect(checkRate("ingest", req())).toBeNull();
  });

  it("caps work in flight and reports busy rather than queueing", () => {
    resetGuards();
    const a = enter("ingest");
    const b = enter("ingest");
    const c = enter("ingest");
    expect(isRefusal(a) || isRefusal(b)).toBe(false);
    expect(isRefusal(c) && c.status === 503 && c.body.code === "busy").toBe(true);
    (a as () => void)();
    expect(isRefusal(enter("ingest"))).toBe(false);
  });
});
