import { GITHUB_API_TIMEOUT_MS, GitHubHttpError, githubFetch, type RequestMetrics } from "../github/client";
import { assertCommitSha, parseRepoRef } from "../github/repo-ref";
import { normalizeArchivePath } from "../ingest/paths";
import type { RepoIdentity } from "./types";

/** Supplies file contents at a pinned commit. Null means the file does not exist at that commit. */
export interface SourceProvider {
  getFile(repo: RepoIdentity, path: string): Promise<string | null>;
}

const MAX_FILE_BYTES = 1024 * 1024;

const DEFAULT_CACHE_BYTES = 16 * 1024 * 1024;

/**
 * Reads files from GitHub at the indexed commit, one request per file, with the same host allowlist as ingestion.
 * A file at a commit never changes, so results are cached (bounded by size) and concurrent requests for one file are shared.
 * Unauthenticated use shares GitHub's 60 requests/hour limit.
 */
export class GitHubRawSource implements SourceProvider {
  readonly metrics: RequestMetrics = { requests: 0, bytes: 0 };
  private readonly cache = new Map<string, string | null>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private cachedBytes = 0;

  constructor(private readonly maxCacheBytes = DEFAULT_CACHE_BYTES) {}

  private remember(key: string, text: string | null): void {
    this.cache.set(key, text);
    this.cachedBytes += text?.length ?? 0;
    for (const oldest of this.cache.keys()) {
      if (this.cachedBytes <= this.maxCacheBytes || this.cache.size <= 1) break;
      this.cachedBytes -= this.cache.get(oldest)?.length ?? 0;
      this.cache.delete(oldest);
    }
  }

  async getFile(repo: RepoIdentity, path: string): Promise<string | null> {
    const { owner, repo: name } = parseRepoRef(`${repo.owner}/${repo.repo}`);
    const sha = assertCommitSha(repo.sha);
    const safe = normalizeArchivePath(path);
    if (!safe.ok) return null;
    const cacheKey = `${owner}/${name}@${sha}:${safe.path}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;
    const pending = this.inflight.get(cacheKey);
    if (pending) return pending;
    const request = this.fetchFile(owner, name, sha, safe.path).then((text) => {
      this.remember(cacheKey, text);
      return text;
    });
    this.inflight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async fetchFile(owner: string, name: string, sha: string, filePath: string): Promise<string | null> {
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    const url = new URL(`https://api.github.com/repos/${owner}/${name}/contents/${encoded}?ref=${sha}`);
    let text: string | null;
    try {
      const res = await githubFetch(url, { accept: "application/vnd.github.raw+json", metrics: this.metrics, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) });
      const buf = Buffer.from(await res.arrayBuffer());
      this.metrics.bytes += buf.length;
      text = buf.length > MAX_FILE_BYTES ? null : buf.toString("utf8");
    } catch (err) {
      if (err instanceof GitHubHttpError && err.status === 404) text = null;
      else throw err;
    }
    return text;
  }
}

/** In-memory source for tests and for benchmarks that read the cached tarball of the pinned commit. */
export class MapSource implements SourceProvider {
  constructor(private readonly files: ReadonlyMap<string, string>) {}

  async getFile(_repo: RepoIdentity, path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
}
