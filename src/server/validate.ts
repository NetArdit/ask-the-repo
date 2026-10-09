import { assertCommitSha, parseRepoRef, type RepoRef } from "../github/repo-ref";

export const MAX_QUESTION_LENGTH = 300;

export class BadRequestError extends Error {
  readonly status = 400;
}

export interface SearchParams {
  ref: RepoRef;
  sha: string;
  question: string;
}

export function parseSearchParams(params: URLSearchParams): SearchParams {
  const repo = params.get("repo");
  const sha = params.get("sha");
  const question = params.get("q");
  if (!repo || !sha || !question) throw new BadRequestError("repo, sha and q are required");
  if (question.length > MAX_QUESTION_LENGTH) throw new BadRequestError(`q is limited to ${MAX_QUESTION_LENGTH} characters`);
  try {
    return { ref: parseRepoRef(repo), sha: assertCommitSha(sha), question };
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : "invalid parameters");
  }
}

export function parseIngestBody(body: unknown): { ref: RepoRef; sha: string | null } {
  if (!body || typeof body !== "object") throw new BadRequestError("JSON body required");
  const { repo, sha } = body as { repo?: unknown; sha?: unknown };
  if (typeof repo !== "string") throw new BadRequestError("repo is required");
  try {
    return { ref: parseRepoRef(repo), sha: typeof sha === "string" ? assertCommitSha(sha) : null };
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : "invalid parameters");
  }
}
