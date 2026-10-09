/**
 * One structured line per answer or ingest request, so a failure in production can be told apart from another: GitHub or Groq
 * rate limit, resource limit, malformed model output, citation failure, abstention. Built only from fields the response already
 * carries, on a fixed allowlist. It never contains the question, the prompt, repository text, a key or a client address.
 */
export interface LogEvent {
  route: "answer" | "ingest";
  status: number;
  /** Fixed vocabulary or an error code from this application. */
  outcome: string;
  /** Provider failure kind or the first rejection code, when there is one. */
  cause?: string;
  modelCalled?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  modelMs?: number;
  files?: number;
  cached?: boolean;
  ms: number;
}

const SAFE = /^[\w:.-]{1,60}$/;
const safe = (v: unknown): string | undefined => (typeof v === "string" && SAFE.test(v) ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Maps a finished response to the allowlisted event. Anything unexpected falls back to the HTTP status. */
export function describeResponse(route: LogEvent["route"], status: number, body: unknown, ms: number): LogEvent {
  const e: LogEvent = { route, status, outcome: `http_${status}`, ms: Math.round(ms) };
  if (!isObject(body)) return e;
  if (typeof body.error === "string") {
    e.outcome = safe(body.code) ?? e.outcome;
    return e;
  }
  const stats = isObject(body.stats) ? body.stats : null;
  if (route === "answer" && safe(body.status)) {
    e.outcome = body.status as string;
    const reasons = Array.isArray(body.reasons) ? body.reasons : [];
    const rejections = Array.isArray(body.rejections) ? body.rejections : [];
    const first = rejections.find(isObject);
    if (e.outcome === "provider_error" && typeof reasons[0] === "string") e.cause = safe(reasons[0].replace("model provider failed: ", ""));
    else e.cause = safe(first?.code);
    if (stats) {
      if (typeof stats.modelCalled === "boolean") e.modelCalled = stats.modelCalled;
      e.inputTokens = num(stats.inputTokens);
      e.outputTokens = num(stats.outputTokens);
      e.modelMs = num(stats.modelMs);
    }
  } else if (route === "ingest" && status === 200) {
    e.outcome = "ingested";
    e.files = num(body.files);
    if (typeof body.cached === "boolean") e.cached = body.cached;
  }
  return e;
}

export function logEvent(e: LogEvent): void {
  const out: Record<string, unknown> = { t: Date.now() };
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  console.info(JSON.stringify(out));
}

/** Wraps a route handler: the response is returned untouched and one event line is written after it. */
export function withEventLog<A extends unknown[]>(route: LogEvent["route"], handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const t0 = performance.now();
    const res = await handler(...args);
    try {
      const body: unknown = await res
        .clone()
        .json()
        .catch(() => null);
      logEvent(describeResponse(route, res.status, body, performance.now() - t0));
    } catch {
      // Logging must never change a response.
    }
    return res;
  };
}
