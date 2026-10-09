import { assertCommitSha, parseRepoRef } from "../github/repo-ref";
import type { IndexStore } from "./store";
import type { IndexKey } from "./types";

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface HttpStoreOptions {
  /** Object URLs are `${baseUrl}/${owner}/${repo}@${sha}.idx.br`. Any HTTP object store that supports PUT and GET on such paths fits. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer ...`. Provider-specific signing (e.g. S3 SigV4) is deliberately not built in. */
  token?: string;
  timeoutMs?: number;
  /** Extra attempts for GETs that fail with a network error or 5xx. */
  retries?: number;
}

/** Provider-agnostic artifact store over plain HTTP. */
export class HttpIndexStore implements IndexStore {
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(private readonly options: HttpStoreOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 1;
  }

  private urlFor(key: IndexKey): string {
    const { owner, repo } = parseRepoRef(`${key.owner}/${key.repo}`);
    return `${this.options.baseUrl.replace(/\/+$/, "")}/${owner}/${repo}@${assertCommitSha(key.sha)}.idx.br`;
  }

  private async request(method: "GET" | "PUT", url: string, body?: Buffer): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (body) headers["Content-Type"] = "application/octet-stream";
    try {
      return await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new StoreError(`${method} failed: ${err instanceof Error ? err.message : String(err)}`, null, true);
    }
  }

  async put(key: IndexKey, data: Buffer): Promise<void> {
    const res = await this.request("PUT", this.urlFor(key), data);
    await res.body?.cancel();
    if (!res.ok) throw new StoreError(`PUT returned ${res.status}`, res.status, res.status >= 500);
  }

  async get(key: IndexKey): Promise<Buffer | null> {
    const url = this.urlFor(key);
    let last: StoreError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.request("GET", url);
        if (res.status === 404) {
          await res.body?.cancel();
          return null;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new StoreError(`GET returned ${res.status}`, res.status, res.status >= 500);
        }
        const body = Buffer.from(await res.arrayBuffer());
        const expected = Number(res.headers.get("content-length"));
        if (Number.isFinite(expected) && expected > 0 && body.length !== expected) {
          throw new StoreError(`truncated body: ${body.length} of ${expected} bytes`, res.status, true);
        }
        return body;
      } catch (err) {
        last = err instanceof StoreError ? err : new StoreError(String(err), null, true);
        if (!last.retryable) break;
      }
    }
    throw last!;
  }
}
