import type { AnswerResult } from "../answer/answer";
import type { RepoSummary, SourceExcerpt } from "../server/repo-handler";

export type { AnswerResult, RepoSummary, SourceExcerpt };

export type FailureKind =
  | "invalid"
  | "not_found"
  | "not_indexed"
  | "too_large"
  | "unprocessable"
  | "rate_limited"
  | "daily_limit"
  | "busy"
  | "github_rate_limited"
  | "no_provider"
  | "model_cooldown"
  | "server"
  | "network"
  | "aborted";

export interface ApiFailure {
  ok: false;
  kind: FailureKind;
  status: number | null;
  /** The server's own short message, when it sent one. Shown only for validation and size errors, which it words for users. */
  serverMessage: string | null;
  retryAfterSeconds: number | null;
}

/** `retryAfterSeconds` is the wait a successful-as-data response named in its Retry-After header, when it named one. */
export type ApiResult<T> = { ok: true; data: T; retryAfterSeconds?: number } | ApiFailure;

export interface IngestResult {
  sha: string;
  files: number;
  chunks: number;
  cached: boolean;
}

type ErrorBody = { error?: unknown; code?: unknown; retryAfterSeconds?: unknown };

export function classifyFailure(status: number, body: ErrorBody | null): ApiFailure {
  const serverMessage = typeof body?.error === "string" ? body.error : null;
  const code = typeof body?.code === "string" ? body.code : null;
  const retryAfterSeconds = typeof body?.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? body.retryAfterSeconds : null;
  let kind: FailureKind = "server";
  if (status === 400) kind = "invalid";
  else if (status === 404) kind = code === "not_indexed" ? "not_indexed" : "not_found";
  else if (status === 413) kind = "too_large";
  else if (status === 422) kind = "unprocessable";
  else if (status === 429) kind = code === "daily_limit" ? "daily_limit" : "rate_limited";
  else if (status === 503) {
    if (code === "busy") kind = "busy";
    else if (code === "no_provider") kind = "no_provider";
    else if (code === "model_cooldown") kind = "model_cooldown";
    else if (code === "source_rate_limited" || code === "github_rate_limited") kind = "github_rate_limited";
  }
  return { ok: false, kind, status, serverMessage, retryAfterSeconds };
}

async function request<T>(input: string, init: RequestInit, accept: (status: number, body: unknown) => body is T): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, kind: aborted ? "aborted" : "network", status: null, serverMessage: null, retryAfterSeconds: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (accept(res.status, body)) {
    const wait = Number(res.headers.get("retry-after") ?? "");
    return Number.isInteger(wait) && wait > 0 ? { ok: true, data: body, retryAfterSeconds: wait } : { ok: true, data: body };
  }
  return classifyFailure(res.status, body && typeof body === "object" ? (body as ErrorBody) : null);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function ingestRepository(repo: string, sha: string | null, signal?: AbortSignal): Promise<ApiResult<IngestResult>> {
  return request("/api/ingest", { method: "POST", body: JSON.stringify(sha ? { repo, sha } : { repo }), signal }, (status, body): body is IngestResult => {
    return status === 200 && isObject(body) && typeof body.sha === "string" && typeof body.files === "number" && typeof body.chunks === "number";
  });
}

export function fetchRepoSummary(repo: string, sha: string, signal?: AbortSignal): Promise<ApiResult<RepoSummary>> {
  const q = new URLSearchParams({ repo, sha });
  return request(`/api/repo?${q}`, { signal }, (status, body): body is RepoSummary => status === 200 && isObject(body) && typeof body.files === "number");
}

/**
 * A 502, or a 429 from the model's own rate limit, still carries a full result (status "provider_error") with the evidence that
 * was retrieved, so it is data. This server's own limiter also answers 429, but with an error body, which is a failure.
 */
export function askQuestion(repo: string, sha: string, question: string, signal?: AbortSignal): Promise<ApiResult<AnswerResult>> {
  return request("/api/answer", { method: "POST", body: JSON.stringify({ repo, sha, question }), signal }, (status, body): body is AnswerResult => {
    return (status === 200 || status === 502 || status === 429) && isObject(body) && typeof body.status === "string" && Array.isArray(body.claims) && Array.isArray(body.evidence);
  });
}

/**
 * Lines at a commit never change, so an excerpt that was fetched once is kept for the page's lifetime (the most recent few).
 * Reopening a citation, or the inspector moving between the side pane and the sheet, then shows it at once without a request.
 */
const MAX_REMEMBERED_EXCERPTS = 40;
const excerpts = new Map<string, SourceExcerpt>();

function sourceUrl(repo: string, sha: string, path: string, start: number, end: number): string {
  return `/api/source?${new URLSearchParams({ repo, sha, path, start: String(start), end: String(end) })}`;
}

/** The excerpt for exactly this range, if it was fetched before. */
export function rememberedSource(repo: string, sha: string, path: string, start: number, end: number): SourceExcerpt | null {
  return excerpts.get(sourceUrl(repo, sha, path, start, end)) ?? null;
}

export async function fetchSource(repo: string, sha: string, path: string, start: number, end: number, signal?: AbortSignal): Promise<ApiResult<SourceExcerpt>> {
  const url = sourceUrl(repo, sha, path, start, end);
  const known = excerpts.get(url);
  if (known) return { ok: true, data: known };
  const res = await request(url, { signal }, (status, body): body is SourceExcerpt => status === 200 && isObject(body) && Array.isArray(body.lines));
  if (res.ok) {
    excerpts.set(url, res.data);
    while (excerpts.size > MAX_REMEMBERED_EXCERPTS) excerpts.delete(excerpts.keys().next().value as string);
  }
  return res;
}
