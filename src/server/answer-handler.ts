import { answerQuestion, type AnswerResult } from "../answer/answer";
import { APP_ANSWER_SETTINGS, DEFAULT_POLICY } from "../answer/defaults";
import { GroqProvider, ProviderError, type ModelProvider } from "../answer/provider";
import type { SourceProvider } from "../answer/source";
import { GitHubHttpError } from "../github/client";
import type { IndexKey } from "../index/types";
import { DEFAULT_SEARCH_OPTIONS } from "../retrieve/defaults";
import type { LoadedIndex } from "../retrieve/loaded-index";
import { INTERNAL_ERROR, logServerError } from "./errors";
import { BadRequestError, MAX_QUESTION_LENGTH } from "./validate";
import { assertCommitSha, parseRepoRef } from "../github/repo-ref";

export function parseAnswerBody(body: unknown): { key: IndexKey; question: string } {
  if (!body || typeof body !== "object") throw new BadRequestError("JSON body required");
  const { repo, sha, question } = body as { repo?: unknown; sha?: unknown; question?: unknown };
  if (typeof repo !== "string" || typeof sha !== "string" || typeof question !== "string" || question.trim() === "") {
    throw new BadRequestError("repo, sha and question are required strings");
  }
  if (question.length > MAX_QUESTION_LENGTH) throw new BadRequestError(`question is limited to ${MAX_QUESTION_LENGTH} characters`);
  try {
    return { key: { ...parseRepoRef(repo), sha: assertCommitSha(sha) }, question };
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : "invalid parameters");
  }
}

/** Chooses the model from server configuration. The key is read here and goes nowhere except the provider's request header. */
export function selectProvider(env: Record<string, string | undefined>, opts: { paced?: boolean } = {}): ModelProvider | null {
  // Groq is the only provider. It needs an explicit model id (GROQ_MODEL); without key and model no provider is selected.
  // `paced` is for long benchmark runs against the free tier; the web route leaves it off and fails fast.
  if (env.GROQ_API_KEY && env.GROQ_MODEL) {
    return new GroqProvider({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL, ...(opts.paced ? { rateLimit: { maxRetries: 4, maxWaitMs: 180_000 } } : {}) });
  }
  return null;
}

export interface AnswerHandlerDeps {
  provider: ModelProvider | null;
  loadIndex(key: IndexKey): Promise<LoadedIndex | null>;
  makeSource(): SourceProvider;
}

export type HandlerResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /**
   * Set when the model itself turned the question away (its rate limit, or a server error of its own), so no answer was served
   * for the call. `retryAfterMs` is the wait it stated with a rate limit, or null when it stated none.
   */
  modelRefused?: { retryAfterMs: number | null };
};

/**
 * Passes every call through untouched and keeps the failure the model raised, if any. The answer pipeline reports only that the
 * provider failed; this is how the route learns that it was a rate limit, and for how long, or a server error on the model's side.
 */
function watchProvider(provider: ModelProvider): { provider: ModelProvider; failure(): ProviderError | null } {
  let failure: ProviderError | null = null;
  return {
    provider: {
      name: provider.name,
      async complete(request, signal) {
        try {
          return await provider.complete(request, signal);
        } catch (err) {
          if (err instanceof ProviderError) failure = err;
          throw err;
        }
      },
    },
    failure: () => failure,
  };
}

export async function handleAnswer(deps: AnswerHandlerDeps, rawBody: unknown): Promise<HandlerResponse> {
  let parsed: ReturnType<typeof parseAnswerBody>;
  try {
    parsed = parseAnswerBody(rawBody);
  } catch (err) {
    if (err instanceof BadRequestError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  if (!deps.provider) return { status: 503, body: { error: "no model provider is configured", code: "no_provider" } };
  let index: LoadedIndex | null;
  try {
    index = await deps.loadIndex(parsed.key);
  } catch (err) {
    logServerError("answer", err);
    return { status: INTERNAL_ERROR.status, body: INTERNAL_ERROR.body };
  }
  if (!index) return { status: 404, body: { error: "index not found for this commit", code: "not_indexed" } };
  const watched = watchProvider(deps.provider);
  try {
    const result: AnswerResult = await answerQuestion(
      { index, repo: parsed.key, source: deps.makeSource(), provider: watched.provider, searchOptions: DEFAULT_SEARCH_OPTIONS, policy: DEFAULT_POLICY, ...APP_ANSWER_SETTINGS },
      parsed.question,
    );
    if (result.status !== "provider_error") return { status: 200, body: result };
    // The model's rate limit is a 429 like any other, with its wait passed on only when the model stated one. The body is still
    // the full result, so the evidence that was retrieved is not lost.
    const failure = watched.failure();
    if (failure?.kind === "rate_limited") {
      const wait = failure.retryAfterMs !== null && failure.retryAfterMs > 0 ? failure.retryAfterMs : null;
      return { status: 429, body: result, modelRefused: { retryAfterMs: wait }, ...(wait !== null ? { headers: { "Retry-After": String(Math.ceil(wait / 1000)) } } : {}) };
    }
    const modelServerError = failure?.kind === "http" && failure.status !== null && failure.status >= 500;
    return { status: 502, body: result, ...(modelServerError ? { modelRefused: { retryAfterMs: null } } : {}) };
  } catch (err) {
    if (err instanceof GitHubHttpError && (err.status === 403 || err.status === 429)) {
      return { status: 503, body: { error: "source rate limited; retry later", code: "source_rate_limited" } };
    }
    logServerError("answer", err);
    return { status: INTERNAL_ERROR.status, body: INTERNAL_ERROR.body };
  }
}
