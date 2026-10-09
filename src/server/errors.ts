import { GitHubHttpError, PrivateRepositoryError } from "../github/client";
import { LimitExceededError } from "../ingest/tarball";
import { BodyTooLargeError } from "./limits";
import { BadRequestError } from "./validate";

export type ErrorResponse = { status: number; body: { error: string; limit?: string; code?: string } };

export const INTERNAL_ERROR: ErrorResponse = { status: 500, body: { error: "internal error" } };
export const BODY_TOO_LARGE: ErrorResponse = { status: 413, body: { error: "request body too large" } };

/** Details stay on the server: the class and message go to the log, never into a response. */
export function logServerError(route: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${route}] ${name}: ${message}`);
}

/** What /api/ingest tells a client. Only known, safe failures get their own status and a fixed message; everything else is a logged 500. */
export function ingestErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof BodyTooLargeError) return BODY_TOO_LARGE;
  if (err instanceof BadRequestError) return { status: 400, body: { error: err.message } };
  if (err instanceof LimitExceededError) return { status: 413, body: { error: err.message, limit: err.kind } };
  if (err instanceof PrivateRepositoryError) return { status: 404, body: { error: err.message } };
  if (err instanceof GitHubHttpError) {
    if (err.status === 404) return { status: 404, body: { error: "repository or commit not found" } };
    if (err.status === 403 || err.status === 429) return { status: 503, body: { error: "GitHub rate limit reached; retry later", code: "github_rate_limited" } };
    if (err.status === 409) return { status: 422, body: { error: "repository cannot be indexed (for example, it has no commits)" } };
  }
  logServerError("ingest", err);
  return INTERNAL_ERROR;
}
