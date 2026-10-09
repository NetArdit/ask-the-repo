import { parsePromptEvidence } from "./prompt";

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Marker used inside `user`; only the deterministic baseline reads it. */
  nonce: string;
  /** Called with the provider's own token accounting when it reports one. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export type ProviderErrorKind = "timeout" | "network" | "http" | "unavailable" | "blocked" | "rate_limited";

/**
 * What a rate-limited response itself said, kept for diagnosis. Only a fixed list of rate-limit headers, the provider's short
 * error type/code, and the one sentence fragment that names the exceeded limit; never a credential, a prompt or a full body.
 */
export interface RateLimitObservation {
  status: number;
  headers: Record<string, string>;
  errorType?: string;
  errorCode?: string;
  /** e.g. "tokens per day (TPD)" and the Limit/Used/Requested figures, when the provider's message states them. */
  limitFragment?: string;
}

const RATE_LIMIT_HEADERS = ["retry-after", "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"] as const;
const SAFE_VALUE = /^[\w.:+\- ]{1,64}$/;

/** Reads the whitelisted fields from a 429 response. Anything missing or unusual is simply left out. */
export function observeRateLimit(status: number, headers: Headers, bodyText: string | null): RateLimitObservation {
  const out: RateLimitObservation = { status, headers: {} };
  for (const name of RATE_LIMIT_HEADERS) {
    const v = headers.get(name);
    if (v !== null && SAFE_VALUE.test(v)) out.headers[name] = v;
  }
  if (bodyText) {
    try {
      const e = (JSON.parse(bodyText.slice(0, 4000)) as { error?: { type?: unknown; code?: unknown; message?: unknown } }).error;
      if (typeof e?.type === "string" && SAFE_VALUE.test(e.type)) out.errorType = e.type;
      if (typeof e?.code === "string" && SAFE_VALUE.test(e.code)) out.errorCode = e.code;
      if (typeof e?.message === "string") {
        const m = /(?:requests|tokens) per (?:minute|hour|day) \([A-Z]{3}\)[^.]{0,160}?Limit \d+, Used \d+, Requested \d+/.exec(e.message);
        if (m && /^[\w.:+\- ]{1,120}$/.test(m[0].replace(/[(),]/g, ""))) out.limitFragment = m[0];
      }
    } catch {
      // A body that is not the expected JSON adds nothing.
    }
  }
  return out;
}

/** Never carries a response body, a prompt or a credential: only a category and, for HTTP, a status (and a wait hint for rate limits). */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly rateLimit: RateLimitObservation | null = null,
  ) {
    super(`model provider failed: ${kind}${status ? ` ${status}` : ""}`);
    this.name = "ProviderError";
  }
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<string>;
}

export interface GroqOptions {
  apiKey: string;
  /** Required: model ids change often, so none is assumed. */
  model: string;
  baseUrl?: string;
  /**
   * Opt-in free-tier execution for long runs: wait for token headroom before each call and retry 429s a bounded number of times.
   * Off by default, so the web route fails fast instead of holding a request open.
   */
  rateLimit?: { maxRetries: number; maxWaitMs: number; expectedOutputTokens?: number };
  /** Test seams. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** Output budget floor: reasoning models count their thinking tokens against max_tokens, which can truncate the JSON. */
const GROQ_MIN_OUTPUT_TOKENS = 4096;
const GROQ_DEFAULT_EXPECTED_OUTPUT_TOKENS = 1000;
const GROQ_BACKOFF_BASE_MS = 2000;
const GROQ_WAIT_MARGIN_MS = 250;

/** "2m52.8s", "690ms", "7.66s" -> milliseconds; null when unparseable. */
export function parseDurationMs(text: string | null): number | null {
  if (!text) return null;
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"]);
  }
  return matched ? Math.ceil(total) : null;
}

function retryAfterMs(headers: Headers): number | null {
  const ra = headers.get("retry-after");
  if (ra !== null && /^\d+(\.\d+)?$/.test(ra.trim())) return Math.ceil(Number(ra) * 1000);
  return parseDurationMs(headers.get("x-ratelimit-reset-tokens")) ?? parseDurationMs(headers.get("x-ratelimit-reset-requests"));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("timeout"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Groq's OpenAI-compatible chat completions API. The key travels only in the Authorization header. */
export class GroqProvider implements ModelProvider {
  readonly name = "groq";
  /** Token bucket as last reported by Groq's response headers; refills at limit per minute. */
  private bucket: { remaining: number; limit: number; at: number } | null = null;

  constructor(private readonly options: GroqOptions) {
    if (!options.apiKey || !options.model) throw new ProviderError("unavailable");
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return (this.options.sleep ?? defaultSleep)(ms, signal);
  }

  private recordBucket(headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining-tokens"));
    const limit = Number(headers.get("x-ratelimit-limit-tokens"));
    if (headers.get("x-ratelimit-remaining-tokens") !== null && headers.get("x-ratelimit-limit-tokens") !== null && Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      this.bucket = { remaining, limit, at: this.now() };
    }
  }

  /** Waits until the bucket has refilled enough for `need` tokens, using the last reported headers rather than a fixed delay. */
  private async waitForHeadroom(need: number, signal: AbortSignal): Promise<void> {
    const b = this.bucket;
    if (!b) return;
    const target = Math.min(need, b.limit);
    const refilled = Math.min(b.limit, b.remaining + ((this.now() - b.at) * b.limit) / 60_000);
    if (refilled >= target) return;
    await this.sleep(Math.ceil(((target - refilled) * 60_000) / b.limit) + GROQ_WAIT_MARGIN_MS, signal);
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string> {
    const rl = this.options.rateLimit;
    const need = Math.ceil((request.system.length + request.user.length) / 4) + (rl?.expectedOutputTokens ?? GROQ_DEFAULT_EXPECTED_OUTPUT_TOKENS);
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      if (rl) await this.waitForHeadroom(need, signal);
      try {
        res = await fetch(`${this.options.baseUrl ?? "https://api.groq.com"}/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            max_tokens: Math.max(request.maxTokens, GROQ_MIN_OUTPUT_TOKENS),
            temperature: 0,
            response_format: { type: "json_object" },
          }),
          signal,
        });
      } catch (err) {
        throw new ProviderError(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network");
      }
      this.recordBucket(res.headers);
      if (res.status !== 429) break;
      // Read (instead of discarding) the body of the response already received, only to extract the whitelisted diagnostics.
      const bodyText = await res.text().catch(() => null);
      const hint = retryAfterMs(res.headers);
      const wait = (hint ?? GROQ_BACKOFF_BASE_MS * 2 ** attempt) + GROQ_WAIT_MARGIN_MS;
      // A wait longer than the cap means a quota window (e.g. the daily limit), not a burst: stop instead of sleeping through it.
      if (!rl || attempt >= rl.maxRetries || wait > rl.maxWaitMs) throw new ProviderError("rate_limited", 429, hint, observeRateLimit(429, res.headers, bodyText));
      await this.sleep(wait, signal);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError("http", res.status);
    }
    let body: { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ProviderError("network");
    }
    const u = body.usage;
    if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
      request.onUsage?.({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens });
    }
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError("http", res.status);
    return text;
  }
}

/**
 * A deterministic stand-in, NOT a language model. It cites the top-ranked evidence with a templated sentence and a verbatim
 * quote. It exists to exercise and measure the retrieval -> evidence -> validation chain without a provider key, and its
 * results say nothing about how a real model would perform.
 */
export class ExtractiveBaselineProvider implements ModelProvider {
  readonly name = "extractive-baseline";

  constructor(private readonly options: { maxClaims?: number; abstainOnLowCoverage?: boolean } = {}) {}

  async complete(request: ModelRequest): Promise<string> {
    const { blocks, lowCoverage } = parsePromptEvidence(request.user, request.nonce);
    if (blocks.length === 0 || (this.options.abstainOnLowCoverage && lowCoverage)) {
      return JSON.stringify({ status: "insufficient_evidence", missing: "no sufficiently relevant evidence was retrieved" });
    }
    const claims = blocks.slice(0, this.options.maxClaims ?? 3).flatMap((b) => {
      const quote = b.lines.find((l) => l.trim().length >= 12 && !/^\s*(\/\/|\/\*|\*|#)/.test(l))?.trim() ?? b.lines.find((l) => l.trim().length > 0)?.trim() ?? "";
      // A block with nothing quotable cannot be cited under the evidence contract, so it yields no claim.
      if (quote.length < 3) return [];
      return [{ text: `${b.path} lines ${b.startLine}-${b.endLine} contain code relevant to the question.`, evidence: [{ citation: b.id, quote: quote.slice(0, 200) }] }];
    });
    if (claims.length === 0) return JSON.stringify({ status: "insufficient_evidence", missing: "the retrieved evidence contained nothing quotable" });
    return JSON.stringify({ status: "answered", claims });
  }
}
