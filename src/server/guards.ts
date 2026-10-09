import { ConcurrencyGate, KeyedWindowCounter, RateLimiter, WindowCounter } from "./limits";

/** `read` covers the cheap lookups (search, repository status, source excerpts). */
export type GuardedRoute = "answer" | "ingest" | "read";

export interface Refusal {
  status: 429 | 503;
  body: { error: string; code: "rate_limited" | "daily_limit" | "client_daily_limit" | "busy" | "model_cooldown"; retryAfterSeconds: number };
  headers: { "Retry-After": string };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The model's free tier is the scarcest thing this server has, so answers get the tightest limits and a daily ceiling.
 * One answer costs about 4,000 tokens against the model's 8,000 a minute and 200,000 a day, so the server as a whole answers
 * about one question a minute (two in a burst), one at a time, and one client one question every two minutes.
 * Ingestion is the most expensive thing to run locally (a download plus parsing), so it is limited over a longer window.
 */
const POLICY = {
  answer: { perClient: [1, 2 * MINUTE], global: [2, 2 * MINUTE], concurrent: 1 },
  ingest: { perClient: [6, 10 * MINUTE], global: [24, 10 * MINUTE], concurrent: 2 },
  read: { perClient: [120, MINUTE], global: [600, MINUTE], concurrent: 0 },
} as const satisfies Record<GuardedRoute, { perClient: readonly [number, number]; global: readonly [number, number]; concurrent: number }>;

/** About half of the model's daily token allowance at the measured cost of an answer. */
const DEFAULT_ANSWERS_PER_DAY = 25;
/** The most one identified client may take of a day's answers, so that one caller cannot use up everyone's. */
const CLIENT_ANSWERS_PER_DAY = 8;

interface State {
  now: () => number;
  perClient: Record<GuardedRoute, RateLimiter>;
  global: Record<GuardedRoute, RateLimiter>;
  daily: WindowCounter;
  clientDaily: KeyedWindowCounter;
  gates: { answer: ConcurrencyGate; ingest: ConcurrencyGate };
  /** Until this time the model has said it will refuse; 0 when it has said nothing. */
  modelCooldownUntil: number;
}

/** Indexing is the memory-hungry operation (hundreds of MB at its peak), so a small host can lower how many run at once. */
function ingestConcurrency(): number {
  const n = Number(process.env.INGEST_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : POLICY.ingest.concurrent;
}

function answersPerDay(): number {
  const n = Number(process.env.ANSWERS_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ANSWERS_PER_DAY;
}

function build(now: () => number): State {
  const limiter = (pair: readonly [number, number]) => new RateLimiter(pair[0], pair[1], now);
  return {
    now,
    perClient: { answer: limiter(POLICY.answer.perClient), ingest: limiter(POLICY.ingest.perClient), read: limiter(POLICY.read.perClient) },
    global: { answer: limiter(POLICY.answer.global), ingest: limiter(POLICY.ingest.global), read: limiter(POLICY.read.global) },
    daily: new WindowCounter(answersPerDay(), DAY, now),
    clientDaily: new KeyedWindowCounter(CLIENT_ANSWERS_PER_DAY, DAY, now),
    gates: { answer: new ConcurrencyGate(POLICY.answer.concurrent), ingest: new ConcurrencyGate(ingestConcurrency()) },
    modelCooldownUntil: 0,
  };
}

let state = build(Date.now);

/** Starts every counter afresh. Tests use it; nothing in the running server does. */
export function resetGuards(now: () => number = Date.now): void {
  state = build(now);
}

const ADDRESS = /^[0-9A-Fa-f:.]{3,45}$/;

/**
 * Who a request is counted against, or null when callers cannot be told apart.
 *
 * A forwarded address is believed only when the operator says a trusted proxy sets it (TRUST_PROXY=1). Proxies append the
 * address they saw to whatever the client sent, so the LAST entry is the one the proxy vouches for; earlier entries are the
 * client's own claim and would let it pick a new identity for every request. Without a trusted proxy there is no per-client
 * limit at all (one shared bucket would let a single caller use up everyone's allowance); the global limits still apply.
 */
export function clientKey(request: Request): string | null {
  if (process.env.TRUST_PROXY !== "1") return null;
  const last = (request.headers.get("x-forwarded-for") ?? "").split(",").at(-1)?.trim() ?? "";
  return ADDRESS.test(last) ? last : null;
}

function refusal(status: 429 | 503, code: Refusal["body"]["code"], error: string, retryAfterMs: number): Refusal {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return { status, body: { error, code, retryAfterSeconds }, headers: { "Retry-After": String(retryAfterSeconds) } };
}

/** Counts the request against its limits. Null means it may proceed; a refused request uses up none of its allowance. */
export function checkRate(route: GuardedRoute, request: Request): Refusal | null {
  if (route === "answer") {
    // The model has said when it will accept requests again. Asking it before then only gets another refusal.
    const left = state.modelCooldownUntil - state.now();
    if (left > 0) return refusal(503, "model_cooldown", "The language model is rate limited right now. Try again later.", left);
  }
  const key = clientKey(request);
  if (key !== null) {
    const mine = state.perClient[route].take(key);
    if (!mine.ok) return refusal(429, "rate_limited", "Too many requests. Wait a moment and try again.", mine.retryAfterMs);
  }
  const all = state.global[route].take("all");
  if (!all.ok) {
    if (key !== null) state.perClient[route].refund(key);
    return refusal(429, "rate_limited", "The server is receiving too many requests. Wait a moment and try again.", all.retryAfterMs);
  }
  if (route === "answer") {
    const day = state.daily.take();
    if (!day.ok) {
      if (key !== null) state.perClient[route].refund(key);
      state.global[route].refund("all");
      return refusal(429, "daily_limit", "This server has reached its daily limit for answers. Try again later.", day.retryAfterMs);
    }
    if (key !== null) {
      const share = state.clientDaily.take(key);
      if (!share.ok) {
        state.perClient[route].refund(key);
        state.global[route].refund("all");
        state.daily.refund();
        return refusal(429, "client_daily_limit", "You have reached your share of today's answers. Try again later.", share.retryAfterMs);
      }
    }
  }
  return null;
}

/**
 * Records that the model refused a question for its own rate limit and said how long to wait. Until then answer requests are
 * turned away here without asking it. A refusal that names no wait starts nothing: no waiting time is made up.
 */
export function startModelCooldown(retryAfterMs: number | null): void {
  if (retryAfterMs === null || !(retryAfterMs > 0)) return;
  state.modelCooldownUntil = Math.max(state.modelCooldownUntil, state.now() + retryAfterMs);
}

/** Takes a slot for work that is expensive while it runs. Returns the release function, or a refusal when all slots are taken. */
export function enter(route: "answer" | "ingest"): (() => void) | Refusal {
  return state.gates[route].tryEnter() ?? refusal(503, "busy", "The server is busy with other requests. Try again in a few seconds.", 5000);
}

export function isRefusal(value: (() => void) | Refusal): value is Refusal {
  return typeof value !== "function";
}

/**
 * An answer request that never reached the model (bad input, unknown index, refused by policy), or that the model itself turned
 * away, should not use up the day's allowance: neither the server's nor the client's share of it.
 */
export function refundDailyAnswer(request?: Request): void {
  state.daily.refund();
  const key = request ? clientKey(request) : null;
  if (key !== null) state.clientDaily.refund(key);
}

/**
 * Gives back the allowance of a request that was refused for its own shape (malformed or oversized). Such a request costs the
 * server almost nothing, and counting it would let anyone lock real users out by sending junk.
 */
export function refundRate(route: GuardedRoute, request: Request): void {
  const key = clientKey(request);
  if (key !== null) state.perClient[route].refund(key);
  state.global[route].refund("all");
}

export function refusalResponse(r: Refusal): Response {
  return Response.json(r.body, { status: r.status, headers: r.headers });
}

/**
 * The two POST routes accept JSON only. A page on another site can make a visitor's browser send a form or text/plain POST without
 * a CORS preflight, so requiring application/json (which such a request cannot send) closes that route to spending a visitor's quota.
 */
export function requireJson(request: Request): Response | null {
  const type = request.headers.get("content-type") ?? "";
  if (/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type)) return null;
  return Response.json({ error: "content-type must be application/json" }, { status: 415 });
}

/** Request bodies here are a repository name, a commit and a short question; anything larger is not a legitimate request. */
export const MAX_BODY_BYTES = 4096;
