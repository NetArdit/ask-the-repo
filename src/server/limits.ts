/**
 * Request controls that need no storage and cost nothing: they live in this process's memory.
 * They protect one server instance. Several instances each keep their own counts, so behind a load balancer the effective
 * limits are multiplied; that is a known boundary of a zero-cost design, not something these classes can fix.
 */

export interface RateDecision {
  ok: boolean;
  /** Milliseconds until one more request would be allowed; 0 when ok. */
  retryAfterMs: number;
}

/** Token bucket per key: `capacity` requests, refilled evenly over `windowMs`. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked keys, so a flood of made-up client addresses cannot grow memory without limit. */
    private readonly maxKeys = 5000,
  ) {
    if (!(capacity > 0) || !(windowMs > 0)) throw new Error("capacity and windowMs must be positive");
  }

  take(key: string): RateDecision {
    const t = this.now();
    const perMs = this.capacity / this.windowMs;
    const b = this.buckets.get(key);
    const tokens = b ? Math.min(this.capacity, b.tokens + (t - b.at) * perMs) : this.capacity;
    // Re-insert so the map stays ordered by last use; the oldest entry is the one to drop.
    this.buckets.delete(key);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: t });
      this.evict();
      return { ok: true, retryAfterMs: 0 };
    }
    this.buckets.set(key, { tokens, at: t });
    this.evict();
    return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / perMs) };
  }

  /** Gives one request back, for a caller that was admitted here but turned away by a later check. */
  refund(key: string): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.capacity, b.tokens + 1);
  }

  private evict(): void {
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }
}

/**
 * A hard ceiling per window: at most `capacity` in any one window, with nothing trickling back in between. The window opens at
 * the first request counted in it. Used where "no more than N a day" has to mean exactly that.
 */
export class WindowCounter {
  private used = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(capacity > 0) || !(windowMs > 0)) throw new Error("capacity and windowMs must be positive");
  }

  take(): RateDecision {
    const t = this.now();
    if (this.openedAt === null || t - this.openedAt >= this.windowMs) {
      this.openedAt = t;
      this.used = 0;
    }
    if (this.used < this.capacity) {
      this.used += 1;
      return { ok: true, retryAfterMs: 0 };
    }
    return { ok: false, retryAfterMs: this.openedAt + this.windowMs - t };
  }

  refund(): void {
    if (this.used > 0) this.used -= 1;
  }
}

/** A `WindowCounter` per key: each key gets its own hard ceiling and its own window. */
export class KeyedWindowCounter {
  private readonly windows = new Map<string, { used: number; openedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked keys, so a flood of made-up client addresses cannot grow memory without limit. */
    private readonly maxKeys = 5000,
  ) {
    if (!(capacity > 0) || !(windowMs > 0)) throw new Error("capacity and windowMs must be positive");
  }

  take(key: string): RateDecision {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.openedAt >= this.windowMs) w = { used: 0, openedAt: t };
    // Re-insert so the map stays ordered by last use; the oldest entry is the one to drop.
    this.windows.delete(key);
    this.windows.set(key, w);
    while (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value as string);
    if (w.used < this.capacity) {
      w.used += 1;
      return { ok: true, retryAfterMs: 0 };
    }
    return { ok: false, retryAfterMs: w.openedAt + this.windowMs - t };
  }

  refund(key: string): void {
    const w = this.windows.get(key);
    if (w && w.used > 0) w.used -= 1;
  }
}

/** Caps work in flight. A caller over the cap is turned away at once rather than queued, so requests cannot pile up. */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly max: number) {
    if (!(max > 0)) throw new Error("max must be positive");
  }

  /** A release function, or null when the gate is full. Calling release more than once is harmless. */
  tryEnter(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  get inFlight(): number {
    return this.active;
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body is limited to ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a JSON body without ever buffering more than `maxBytes`. An oversized body is refused from its declared length when
 * there is one, and otherwise as soon as the stream passes the limit. Anything that is not valid JSON yields null.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
