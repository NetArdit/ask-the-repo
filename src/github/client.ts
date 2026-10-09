import { assertCommitSha, type RepoRef } from "./repo-ref";

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.github.com", "codeload.github.com"]);
const MAX_REDIRECTS = 3;

export class DisallowedHostError extends Error {
  constructor(host: string) {
    super(`Host not allowed: ${host}`);
    this.name = "DisallowedHostError";
  }
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly rateLimitRemaining: string | null,
  ) {
    super(`GitHub responded ${status} for ${new URL(url).pathname}`);
    this.name = "GitHubHttpError";
  }
}

/** Same budget the index store uses for one HTTP call. Callers opt in; the benchmark's long tarball downloads do not. */
export const GITHUB_API_TIMEOUT_MS = 10_000;

export class PrivateRepositoryError extends Error {
  constructor() {
    super("Private repositories are not supported");
    this.name = "PrivateRepositoryError";
  }
}

export interface RequestMetrics {
  requests: number;
  bytes: number;
}

export function newMetrics(): RequestMetrics {
  return { requests: 0, bytes: 0 };
}

export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.port !== "" || url.username || url.password) {
    throw new DisallowedHostError(url.host);
  }
}

function headers(url: URL, accept: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "User-Agent": "ask-the-repo",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  // The token is only ever sent to the REST API host, never to a redirect target.
  if (token && url.hostname === "api.github.com") h.Authorization = `Bearer ${token}`;
  return h;
}

/** Fetch with a host allowlist enforced on the initial URL and on every redirect hop. */
export async function githubFetch(
  initial: URL,
  opts: { accept?: string; signal?: AbortSignal; metrics?: RequestMetrics } = {},
): Promise<Response> {
  let url = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(url);
    if (opts.metrics) opts.metrics.requests += 1;
    const res = await fetch(url, {
      headers: headers(url, opts.accept ?? "application/vnd.github+json"),
      redirect: "manual",
      signal: opts.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new GitHubHttpError(res.status, url.toString(), null);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new GitHubHttpError(res.status, url.toString(), res.headers.get("x-ratelimit-remaining"));
    }
    return res;
  }
  throw new Error("Too many redirects");
}

async function getJson<T>(path: string, metrics?: RequestMetrics, signal?: AbortSignal): Promise<T> {
  const res = await githubFetch(new URL(`https://api.github.com${path}`), { metrics, signal });
  const text = await res.text();
  if (metrics) metrics.bytes += Buffer.byteLength(text);
  return JSON.parse(text) as T;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  sizeKb: number;
  isPrivate: boolean;
  archived: boolean;
  disabled: boolean;
  language: string | null;
}

export async function fetchRepoInfo(ref: RepoRef, metrics?: RequestMetrics, signal?: AbortSignal): Promise<RepoInfo> {
  const json = await getJson<{
    default_branch: string;
    size: number;
    private: boolean;
    archived: boolean;
    disabled: boolean;
    language: string | null;
    name: string;
    owner: { login: string };
  }>(`/repos/${ref.owner}/${ref.repo}`, metrics, signal);
  if (json.private) throw new PrivateRepositoryError();
  return {
    owner: json.owner.login,
    repo: json.name,
    defaultBranch: json.default_branch,
    sizeKb: json.size,
    isPrivate: json.private,
    archived: json.archived,
    disabled: json.disabled,
    language: json.language,
  };
}

export async function resolveCommitSha(ref: RepoRef, branch: string, metrics?: RequestMetrics, signal?: AbortSignal): Promise<string> {
  const res = await githubFetch(
    new URL(`https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}`),
    { accept: "application/vnd.github.sha", metrics, signal },
  );
  const sha = (await res.text()).trim();
  if (metrics) metrics.bytes += sha.length;
  return assertCommitSha(sha);
}

export function tarballUrl(ref: RepoRef, sha: string): URL {
  return new URL(`https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${assertCommitSha(sha)}`);
}
