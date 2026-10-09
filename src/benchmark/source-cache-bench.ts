import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitHubHttpError } from "../github/client";
import type { SourceProvider } from "../answer/source";
import { CachingSource, FsSourceCache, MemorySourceCache } from "../answer/source-cache";
import type { RepoIdentity } from "../answer/types";
import { median } from "./evaluate";

const REPO: RepoIdentity = { owner: "acme", repo: "shop", sha: "d".repeat(40) };

/** Stands in for GitHub: fixed latency, optional transient failures. Every number below is emulated, not a GitHub measurement. */
class EmulatedGitHub implements SourceProvider {
  calls = 0;
  constructor(
    private readonly latencyMs: number,
    private readonly failEvery = 0,
  ) {}

  async getFile(_repo: RepoIdentity, p: string): Promise<string | null> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failEvery && this.calls % this.failEvery === 0) throw new GitHubHttpError(502, "https://api.github.com/x", null);
    return `// ${p}\n${"const x = 1;\n".repeat(400)}`;
  }
}

const time = async (fn: () => Promise<unknown>): Promise<number> => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

export async function runSourceCacheBench(latencyMs = 120): Promise<Record<string, unknown>> {
  const files = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
  const out: Record<string, unknown> = { emulated: true, emulatedUpstreamLatencyMs: latencyMs, fileBytes: 5200 };

  const upstream = new EmulatedGitHub(latencyMs);
  const mem = new CachingSource(upstream, new MemorySourceCache(64 * 1024 * 1024));
  const missTimes: number[] = [];
  for (const f of files) missTimes.push(await time(() => mem.getFile(REPO, f)));
  const hitTimes: number[] = [];
  for (const f of files) hitTimes.push(await time(() => mem.getFile(REPO, f)));
  out.missPath = { requests: files.length, medianMs: +median(missTimes).toFixed(1), upstreamCalls: upstream.calls };
  out.memoryHitPath = { requests: files.length, medianMs: +median(hitTimes).toFixed(3), upstreamCalls: upstream.calls, stats: mem.stats };

  const dir = await mkdtemp(path.join(tmpdir(), "atr-cache-bench-"));
  try {
    const fsWarm = new CachingSource(new EmulatedGitHub(latencyMs), new FsSourceCache(dir, 64 * 1024 * 1024));
    for (const f of files) await fsWarm.getFile(REPO, f);
    const cold = new EmulatedGitHub(latencyMs);
    const fsReopened = new CachingSource(cold, new FsSourceCache(dir, 64 * 1024 * 1024));
    const fsHit: number[] = [];
    for (const f of files) fsHit.push(await time(() => fsReopened.getFile(REPO, f)));
    out.diskHitPathNewProcessState = { requests: files.length, medianMs: +median(fsHit).toFixed(2), upstreamCalls: cold.calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const hot = new EmulatedGitHub(latencyMs);
  const concurrent = new CachingSource(hot, new MemorySourceCache(64 * 1024 * 1024));
  const wall = await time(() => Promise.all(Array.from({ length: 200 }, (_, i) => concurrent.getFile(REPO, files[i % 10]!))));
  out.concurrency = { requests: 200, distinctFiles: 10, upstreamCalls: hot.calls, wallMs: Math.round(wall), coalesced: concurrent.stats.coalesced };

  const flaky = new EmulatedGitHub(latencyMs, 3);
  const retrying = new CachingSource(flaky, new MemorySourceCache(64 * 1024 * 1024), { retries: 2, retryDelayMs: 20 });
  let ok = 0;
  let failed = 0;
  for (const f of files.slice(0, 30)) await retrying.getFile(REPO, f).then(() => ok++, () => failed++);
  out.transientFailures = { failureEvery: 3, requests: 30, ok, failed, retries: retrying.stats.retries, upstreamCalls: flaky.calls };

  const small = new MemorySourceCache(100 * 1024);
  const tight = new CachingSource(new EmulatedGitHub(1), small);
  for (const f of files) await tight.getFile(REPO, f);
  out.byteLimit = { limitBytes: 100 * 1024, filesFetched: files.length, evictions: small.evictions, bytesHeld: small.byteSize };
  return out;
}
