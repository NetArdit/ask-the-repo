import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubHttpError } from "../github/client";
import { CachingSource, FsSourceCache, MemorySourceCache, sourceCacheKey } from "./source-cache";
import type { SourceProvider } from "./source";
import { TEST_REPO } from "./test-helpers";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

class FakeInner implements SourceProvider {
  calls: string[] = [];
  failures: unknown[] = [];
  delayMs = 0;
  files = new Map<string, string>();
  async getFile(_repo: unknown, p: string): Promise<string | null> {
    this.calls.push(p);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const f = this.failures.shift();
    if (f) throw f;
    return this.files.get(p) ?? null;
  }
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}
const noSleep = async () => {};

describe("sourceCacheKey", () => {
  it("is SHA-keyed and refuses unsafe paths", () => {
    expect(sourceCacheKey(TEST_REPO, "src/a.ts")).toBe(`acme/shop@${TEST_REPO.sha}:src/a.ts`);
    expect(sourceCacheKey({ ...TEST_REPO, sha: "e".repeat(40) }, "src/a.ts")).not.toBe(sourceCacheKey(TEST_REPO, "src/a.ts"));
    expect(sourceCacheKey(TEST_REPO, "../../etc/passwd")).toBeNull();
    expect(sourceCacheKey(TEST_REPO, "/etc/passwd")).toBeNull();
    expect(() => sourceCacheKey({ ...TEST_REPO, sha: "main" }, "a.ts")).toThrow();
  });
});

describe("CachingSource", () => {
  it("serves repeats from the cache and counts hits and misses", async () => {
    const inner = new FakeInner();
    inner.files.set("a.ts", "const a = 1;");
    const s = new CachingSource(inner, new MemorySourceCache(1e6));
    expect(await s.getFile(TEST_REPO, "a.ts")).toBe("const a = 1;");
    expect(await s.getFile(TEST_REPO, "a.ts")).toBe("const a = 1;");
    expect(inner.calls).toEqual(["a.ts"]);
    expect(s.stats).toMatchObject({ misses: 1, hits: 1, stores: 1 });
  });

  it("keys by commit: the same path at another SHA is a separate entry", async () => {
    const inner = new FakeInner();
    inner.files.set("a.ts", "x");
    const s = new CachingSource(inner, new MemorySourceCache(1e6));
    await s.getFile(TEST_REPO, "a.ts");
    await s.getFile({ ...TEST_REPO, sha: "e".repeat(40) }, "a.ts");
    expect(inner.calls).toHaveLength(2);
  });

  it("shares one fetch between concurrent requests for the same file", async () => {
    const inner = new FakeInner();
    inner.files.set("a.ts", "x");
    inner.delayMs = 30;
    const s = new CachingSource(inner, new MemorySourceCache(1e6));
    const out = await Promise.all(Array.from({ length: 25 }, () => s.getFile(TEST_REPO, "a.ts")));
    expect(out.every((t) => t === "x")).toBe(true);
    expect(inner.calls).toHaveLength(1);
    expect(s.stats).toMatchObject({ misses: 1, coalesced: 24 });
  });

  it("expires entries after the TTL, with a shorter TTL for missing files", async () => {
    const c = clock();
    const inner = new FakeInner();
    inner.files.set("a.ts", "x");
    const s = new CachingSource(inner, new MemorySourceCache(1e6), { ttlMs: 1000, negativeTtlMs: 100, now: c.now });
    await s.getFile(TEST_REPO, "a.ts");
    await s.getFile(TEST_REPO, "gone.ts");
    c.advance(150);
    await s.getFile(TEST_REPO, "a.ts");
    await s.getFile(TEST_REPO, "gone.ts");
    expect(inner.calls).toEqual(["a.ts", "gone.ts", "gone.ts"]);
    c.advance(1000);
    await s.getFile(TEST_REPO, "a.ts");
    expect(inner.calls.filter((p) => p === "a.ts")).toHaveLength(2);
    expect(s.stats.expired).toBeGreaterThanOrEqual(2);
    expect(s.stats.negativeHits).toBe(0);
  });

  it("caches a missing file as a negative entry until its TTL ends", async () => {
    const inner = new FakeInner();
    const s = new CachingSource(inner, new MemorySourceCache(1e6));
    expect(await s.getFile(TEST_REPO, "gone.ts")).toBeNull();
    expect(await s.getFile(TEST_REPO, "gone.ts")).toBeNull();
    expect(inner.calls).toHaveLength(1);
    expect(s.stats.negativeHits).toBe(1);
  });

  it("serves but does not cache files over the size limit", async () => {
    const inner = new FakeInner();
    inner.files.set("big.ts", "x".repeat(500));
    const s = new CachingSource(inner, new MemorySourceCache(1e6), { maxFileBytes: 100 });
    expect((await s.getFile(TEST_REPO, "big.ts"))?.length).toBe(500);
    await s.getFile(TEST_REPO, "big.ts");
    expect(inner.calls).toHaveLength(2);
    expect(s.stats.skippedTooLarge).toBe(2);
  });

  it("retries transient failures with backoff and gives up after the limit", async () => {
    const inner = new FakeInner();
    inner.files.set("a.ts", "ok");
    inner.failures = [new TypeError("fetch failed"), new GitHubHttpError(502, "https://api.github.com/x", null)];
    const delays: number[] = [];
    const s = new CachingSource(inner, new MemorySourceCache(1e6), { retries: 2, retryDelayMs: 10, sleep: async (ms) => void delays.push(ms) });
    expect(await s.getFile(TEST_REPO, "a.ts")).toBe("ok");
    expect(delays).toEqual([10, 20]);
    expect(s.stats.retries).toBe(2);

    const bad = new FakeInner();
    bad.failures = [new TypeError("x"), new TypeError("x"), new TypeError("x"), new TypeError("x")];
    const s2 = new CachingSource(bad, new MemorySourceCache(1e6), { retries: 2, sleep: noSleep });
    await expect(s2.getFile(TEST_REPO, "a.ts")).rejects.toThrow();
    expect(bad.calls).toHaveLength(3);
    expect(s2.stats.failures).toBe(1);
  });

  it("does not retry rate limits or client errors, and never caches a failure", async () => {
    for (const status of [403, 429, 400]) {
      const inner = new FakeInner();
      inner.files.set("a.ts", "ok");
      inner.failures = [new GitHubHttpError(status, "https://api.github.com/x", "0")];
      const s = new CachingSource(inner, new MemorySourceCache(1e6), { sleep: noSleep });
      await expect(s.getFile(TEST_REPO, "a.ts")).rejects.toMatchObject({ status });
      expect(inner.calls).toHaveLength(1);
      expect(await s.getFile(TEST_REPO, "a.ts")).toBe("ok");
    }
  });

  it("returns null for unsafe paths without touching the source or the cache", async () => {
    const inner = new FakeInner();
    const s = new CachingSource(inner, new MemorySourceCache(1e6));
    expect(await s.getFile(TEST_REPO, "../../x")).toBeNull();
    expect(inner.calls).toHaveLength(0);
  });
});

describe("MemorySourceCache", () => {
  it("evicts the least recently used entries when over its byte limit", async () => {
    const cache = new MemorySourceCache(400);
    for (const k of ["a", "b", "c"]) await cache.set(k, { text: "x".repeat(150), storedAt: 1 });
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("c")).not.toBeNull();
    expect(cache.evictions).toBeGreaterThan(0);
    expect(cache.byteSize).toBeLessThanOrEqual(400);
  });
});

describe("FsSourceCache", () => {
  async function tmp(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), "atr-src-cache-"));
    dirs.push(d);
    return d;
  }

  it("persists across instances and names files by hash, not by path", async () => {
    const dir = await tmp();
    const key = sourceCacheKey(TEST_REPO, "src/a.ts")!;
    await new FsSourceCache(dir, 1e6).set(key, { text: "hello", storedAt: 5 });
    expect(await new FsSourceCache(dir, 1e6).get(key)).toEqual({ text: "hello", storedAt: 5 });
    const names = (await readdir(dir, { recursive: true })).join("|");
    expect(names).not.toContain("a.ts");
    expect(names).not.toContain(TEST_REPO.sha);
  });

  it("treats a corrupt or mismatched file as a miss", async () => {
    const dir = await tmp();
    const cache = new FsSourceCache(dir, 1e6);
    const key = sourceCacheKey(TEST_REPO, "src/a.ts")!;
    await cache.set(key, { text: "hello", storedAt: 5 });
    const [sub] = await readdir(dir);
    const [file] = await readdir(path.join(dir, sub!));
    await writeFile(path.join(dir, sub!, file!), "{not json");
    expect(await cache.get(key)).toBeNull();
    await writeFile(path.join(dir, sub!, file!), JSON.stringify({ key: "other", text: "x", storedAt: 1 }));
    expect(await cache.get(key)).toBeNull();
  });

  it("evicts the oldest files when the directory exceeds its byte limit", async () => {
    const dir = await tmp();
    const cache = new FsSourceCache(dir, 700);
    for (let i = 0; i < 6; i++) {
      await cache.set(sourceCacheKey(TEST_REPO, `f${i}.ts`)!, { text: "x".repeat(200), storedAt: i });
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(cache.evictions).toBeGreaterThan(0);
    expect(await cache.get(sourceCacheKey(TEST_REPO, "f5.ts")!)).not.toBeNull();
  });
});
