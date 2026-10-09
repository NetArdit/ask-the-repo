/**
 * Remembers, briefly, which commit a repository's default branch pointed at. Finding it costs two GitHub API requests, and an
 * unauthenticated server gets sixty an hour, so re-opening a repository moments later should not spend them again.
 * The price is that a push made within the last minute may not be seen until the entry expires.
 */
export class LatestCommitCache {
  private readonly entries = new Map<string, { sha: string; at: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /** `resolve` is called only when there is no fresh entry; identical lookups already under way are shared. */
  async get(owner: string, repo: string, resolve: () => Promise<string>): Promise<string> {
    // GitHub treats owner and repository names case-insensitively, so both spellings are one entry.
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.sha;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const work = resolve()
      .then((sha) => {
        this.entries.delete(key);
        this.entries.set(key, { sha, at: this.now() });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
        return sha;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  clear(): void {
    this.entries.clear();
  }
}
