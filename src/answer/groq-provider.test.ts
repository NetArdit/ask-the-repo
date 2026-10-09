import { afterEach, describe, expect, it, vi } from "vitest";
import { selectProvider } from "../server/answer-handler";
import { GroqProvider, ProviderError, type ModelRequest } from "./provider";

afterEach(() => vi.unstubAllGlobals());

const KEY = "gsk_test_secret_123";
const REQ: ModelRequest = { system: "sys", user: "usr", maxTokens: 50, nonce: "n" };
const SIGNAL = () => AbortSignal.timeout(2000);
describe("selectProvider with Groq", () => {
  it("needs both a key and an explicit model, and never guesses a model", () => {
    expect(selectProvider({ GROQ_API_KEY: "k", GROQ_MODEL: "m" })).toBeInstanceOf(GroqProvider);
    expect(selectProvider({ GROQ_API_KEY: "k" })).toBeNull();
    expect(selectProvider({ GROQ_MODEL: "m" })).toBeNull();
  });
});

describe("GroqProvider (HTTP contract against a stubbed fetch; no real model was called)", () => {
  it("sends the key only in the Authorization header and returns text and usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const usage: unknown[] = [];
    const out = await new GroqProvider({ apiKey: KEY, model: "some/model" }).complete({ ...REQ, onUsage: (u) => usage.push(u) }, SIGNAL());
    expect(out).toBe("{}");
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("some/model");
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "usr" }]);
    expect(String(init.body)).not.toContain(KEY);
  });

  it("maps HTTP errors and empty replies without leaking the key, and refuses to start without key or model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`bad ${KEY}`, { status: 500 })));
    const err = await new GroqProvider({ apiKey: KEY, model: "m" }).complete(REQ, SIGNAL()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "http", status: 500 });
    expect(String(err)).not.toContain(KEY);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }))));
    await expect(new GroqProvider({ apiKey: KEY, model: "m" }).complete(REQ, SIGNAL())).rejects.toBeInstanceOf(ProviderError);
    expect(() => new GroqProvider({ apiKey: "", model: "m" })).toThrow(ProviderError);
    expect(() => new GroqProvider({ apiKey: KEY, model: "" })).toThrow(ProviderError);
  });
});

describe("token accounting", () => {
  it("reports the provider's own usage through onUsage and never invents it", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 812, completion_tokens: 97 } }))));
    await new GroqProvider({ apiKey: KEY, model: "m" }).complete({ ...REQ, onUsage: (u) => seen.push(u) }, SIGNAL());
    expect(seen).toEqual([{ inputTokens: 812, outputTokens: 97 }]);
    const none: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))));
    await new GroqProvider({ apiKey: KEY, model: "m" }).complete({ ...REQ, onUsage: (u) => none.push(u) }, SIGNAL());
    expect(none).toEqual([]);
  });
});
