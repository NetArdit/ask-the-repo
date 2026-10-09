import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubHttpError } from "../github/client";
import { assertCommitSha, parseRepoRef } from "../github/repo-ref";
import { normalizeArchivePath } from "../ingest/paths";
import type { SourceProvider } from "./source";
import type { RepoIdentity } from "./types";

/** A cached file, or a cached "this path does not exist at this commit" (text null). */
export interface CacheEntry {
  text: string | null;
  storedAt: number;
}

/** Provider-neutral store for file contents keyed by commit and path. Memory and local-disk implementations live here. */
export interface SourceCache {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/** owner/repo@sha:path. Everything is re-validated, so a key can never name anything outside its commit. */
export function sourceCacheKey(repo: RepoIdentity, filePath: string): string | null {
  const { owner, repo: name } = parseRepoRef(`${repo.owner}/${repo.repo}`);
  const sha = assertCommitSha(repo.sha);
  const safe = normalizeArchivePath(filePath);
  return safe.ok ? `${owner}/${name}@${sha}:${safe.path}` : null;
}

const size = (e: CacheEntry): number => (e.text?.length ?? 0) + 64;

export class MemorySourceCache implements SourceCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;
  evictions = 0;

  constructor(private readonly maxBytes: number) {}

  async get(key: string): Promise<CacheEntry | null> {
    const e = this.map.get(key);
    if (!e) return null;
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const old = this.map.get(key);
    if (old) this.bytes -= size(old);
    this.map.delete(key);
    this.map.set(key, entry);
    this.bytes += size(entry);
    for (const k of this.map.keys()) {
      if (this.bytes <= this.maxBytes || this.map.size <= 1) break;
      this.bytes -= size(this.map.get(k)!);
      this.map.delete(k);
      this.evictions += 1;
    }
  }

  get byteSize(): number {
    return this.bytes;
  }
}

/**
 * Local-disk cache. Files are named by a hash of the key, never by the path, so nothing a repository contains can choose where
 * a cache file lands. A corrupt or unreadable entry is a miss. This stands in for an object store; it is not one.
 */
export class FsSourceCache implements SourceCache {
  evictions = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  private fileFor(key: string): string {
    const h = createHash("sha256").update(key).digest("hex");
    return path.join(this.dir, h.slice(0, 2), `${h}.json`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(key), "utf8")) as { key?: string; text?: string | null; storedAt?: number };
      if (parsed.key !== key || typeof parsed.storedAt !== "number" || (parsed.text !== null && typeof parsed.text !== "string")) return null;
      return { text: parsed.text, storedAt: parsed.storedAt };
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    // Unique per write, so concurrent writers of one key never share a temp file; a failed write leaves nothing behind.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ key, text: entry.text, storedAt: entry.storedAt }));
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await this.trim();
  }

  /** Oldest files go first when the directory is over its byte limit. */
  private async trim(): Promise<void> {
    const files: { file: string; bytes: number; mtime: number }[] = [];
    for (const sub of await readdir(this.dir).catch(() => [])) {
      const d = path.join(this.dir, sub);
      for (const f of await readdir(d).catch(() => [])) {
        if (!f.endsWith(".json")) continue;
        const s = await stat(path.join(d, f)).catch(() => null);
        if (s) files.push({ file: path.join(d, f), bytes: s.size, mtime: s.mtimeMs });
      }
    }
    let total = files.reduce((a, f) => a + f.bytes, 0);
    for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.maxBytes) break;
      await rm(f.file, { force: true });
      total -= f.bytes;
      this.evictions += 1;
    }
  }
}

export interface CachingSourceOptions {
  /** How long a cached file is served. Content at a commit never changes, so this only bounds storage and staleness of "missing". */
  ttlMs: number;
  /** TTL for "no such file" results */
  negativeTtlMs: number;
  /** Files larger than this are served but not cached */
  maxFileBytes: number;
  /** Extra attempts for transient failures (network error, 5xx) */
  retries: number;
  retryDelayMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CACHING_OPTIONS: CachingSourceOptions = {
  ttlMs: 24 * 60 * 60 * 1000,
  negativeTtlMs: 10 * 60 * 1000,
  maxFileBytes: 1024 * 1024,
  retries: 2,
  retryDelayMs: 200,
};

export interface CacheStats {
  hits: number;
  negativeHits: number;
  misses: number;
  /** Requests that waited on an identical in-flight fetch instead of making their own */
  coalesced: number;
  stores: number;
  /** Writes to the cache that failed; the file was still returned to the caller */
  storeFailures: number;
  skippedTooLarge: number;
  retries: number;
  failures: number;
  expired: number;
}

function retryable(err: unknown): boolean {
  if (err instanceof GitHubHttpError) return err.status >= 500;
  return true; // network-level failure
}

export class CachingSource implements SourceProvider {
  readonly stats: CacheStats = { hits: 0, negativeHits: 0, misses: 0, coalesced: 0, stores: 0, storeFailures: 0, skippedTooLarge: 0, retries: 0, failures: 0, expired: 0 };
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly options: CachingSourceOptions;

  constructor(
    private readonly inner: SourceProvider,
    private readonly cache: SourceCache,
    options: Partial<CachingSourceOptions> = {},
  ) {
    this.options = { ...DEFAULT_CACHING_OPTIONS, ...options };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async getFile(repo: RepoIdentity, filePath: string): Promise<string | null> {
    const key = sourceCacheKey(repo, filePath);
    if (key === null) return null;
    const entry = await this.cache.get(key);
    if (entry) {
      const ttl = entry.text === null ? this.options.negativeTtlMs : this.options.ttlMs;
      if (this.now() - entry.storedAt < ttl) {
        if (entry.text === null) this.stats.negativeHits += 1;
        else this.stats.hits += 1;
        return entry.text;
      }
      this.stats.expired += 1;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced += 1;
      return pending;
    }
    this.stats.misses += 1;
    const work = this.fetchWithRetry(repo, filePath).then(async (text) => {
      if (text !== null && text.length > this.options.maxFileBytes) this.stats.skippedTooLarge += 1;
      else {
        // The text was fetched; failing to remember it (disk full, a rename that lost a race) must not fail the read.
        try {
          await this.cache.set(key, { text, storedAt: this.now() });
          this.stats.stores += 1;
        } catch {
          this.stats.storeFailures += 1;
        }
      }
      return text;
    });
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchWithRetry(repo: RepoIdentity, filePath: string): Promise<string | null> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.getFile(repo, filePath);
      } catch (err) {
        if (attempt >= this.options.retries || !retryable(err)) {
          this.stats.failures += 1;
          throw err;
        }
        this.stats.retries += 1;
        await sleep(this.options.retryDelayMs * 2 ** attempt);
      }
    }
  }
}
