import { permalink } from "../answer/evidence";
import type { SourceProvider } from "../answer/source";
import { GitHubHttpError } from "../github/client";
import { assertCommitSha, parseRepoRef } from "../github/repo-ref";
import { splitLines } from "../index/hash";
import { ENTRY_KIND_CODES, LANGUAGE_CODES, type IndexKey } from "../index/types";
import { normalizeArchivePath } from "../ingest/paths";
import type { LoadedIndex } from "../retrieve/loaded-index";
import { INTERNAL_ERROR, logServerError } from "./errors";
import { BadRequestError } from "./validate";

export type HandlerResult = { status: number; body: unknown };

/** What a client may know about an index: counts and declared entry points. No source text, no server internals. */
export interface RepoSummary {
  repo: string;
  sha: string;
  files: number;
  chunks: number;
  symbols: number;
  /** Indexed files per language. */
  languages: Record<string, number>;
  /** Package entry points declared in the repository's own configuration, when they resolve to an indexed file. */
  entryPoints: { path: string; kind: string; package: string }[];
  indexedAt: string;
}

const MAX_ENTRY_POINTS = 6;

export function summarizeIndex(index: LoadedIndex): RepoSummary {
  const { artifact } = index;
  const languages: Record<string, number> = {};
  for (const f of artifact.files) {
    const lang = LANGUAGE_CODES[f[1]] ?? "other";
    languages[lang] = (languages[lang] ?? 0) + 1;
  }
  return {
    repo: `${artifact.key.owner}/${artifact.key.repo}`,
    sha: artifact.key.sha,
    files: index.fileCount,
    chunks: index.chunkCount,
    symbols: artifact.symbols.length,
    languages,
    entryPoints: index.entryFiles.slice(0, MAX_ENTRY_POINTS).map((e) => ({ path: index.pathOf(e.file), kind: ENTRY_KIND_CODES[e.kind] ?? "entry", package: e.pkg })),
    indexedAt: artifact.createdAt,
  };
}

export function parseRepoParams(params: URLSearchParams): IndexKey {
  const repo = params.get("repo");
  const sha = params.get("sha");
  if (!repo || !sha) throw new BadRequestError("repo and sha are required");
  try {
    return { ...parseRepoRef(repo), sha: assertCommitSha(sha) };
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : "invalid parameters");
  }
}

const NOT_INDEXED: HandlerResult = { status: 404, body: { error: "index not found for this commit", code: "not_indexed" } };

export async function handleRepoStatus(loadIndex: (key: IndexKey) => Promise<LoadedIndex | null>, params: URLSearchParams): Promise<HandlerResult> {
  let key: IndexKey;
  try {
    key = parseRepoParams(params);
  } catch (err) {
    if (err instanceof BadRequestError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  try {
    const index = await loadIndex(key);
    return index ? { status: 200, body: summarizeIndex(index) } : NOT_INDEXED;
  } catch (err) {
    logServerError("repo", err);
    return INTERNAL_ERROR;
  }
}

/** Most lines one request may return. An evidence span is at most a chunk; this leaves room for context around it. */
export const MAX_SOURCE_LINES = 400;
/** A single very long line is cut for display; the permalink still leads to the whole file. */
export const MAX_LINE_CHARS = 2000;

export interface SourceQuery {
  key: IndexKey;
  path: string;
  start: number;
  end: number;
}

export interface SourceExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  /** Lines in the whole file at this commit. */
  lineCount: number;
  lines: string[];
  /** How many of `lines` were cut at MAX_LINE_CHARS. */
  truncatedLines: number;
  /** Permalink to these lines at the pinned commit, built by the server. */
  url: string;
}

const LINE_NUMBER = /^[1-9]\d{0,6}$/;

export function parseSourceParams(params: URLSearchParams): SourceQuery {
  const key = parseRepoParams(params);
  const rawPath = params.get("path");
  const start = params.get("start");
  const end = params.get("end");
  if (!rawPath || !start || !end) throw new BadRequestError("path, start and end are required");
  const safe = normalizeArchivePath(rawPath);
  if (!safe.ok) throw new BadRequestError("path is not a valid repository path");
  if (!LINE_NUMBER.test(start) || !LINE_NUMBER.test(end)) throw new BadRequestError("start and end must be line numbers");
  const a = Number(start);
  const b = Number(end);
  if (b < a) throw new BadRequestError("end must not be before start");
  if (b - a + 1 > MAX_SOURCE_LINES) throw new BadRequestError(`at most ${MAX_SOURCE_LINES} lines per request`);
  return { key, path: safe.path, start: a, end: b };
}

const indexedPaths = new WeakMap<LoadedIndex, Set<string>>();

function isIndexedPath(index: LoadedIndex, path: string): boolean {
  let set = indexedPaths.get(index);
  if (!set) {
    set = new Set(index.artifact.files.map((f) => f[0]));
    indexedPaths.set(index, set);
  }
  return set.has(path);
}

export interface SourceDeps {
  loadIndex(key: IndexKey): Promise<LoadedIndex | null>;
  source: SourceProvider;
}

/**
 * Returns lines of one file at the indexed commit. Only files that are part of the index can be read, so this cannot be used
 * to fetch arbitrary GitHub content through the server.
 */
export async function handleSource(deps: SourceDeps, params: URLSearchParams): Promise<HandlerResult> {
  let q: SourceQuery;
  try {
    q = parseSourceParams(params);
  } catch (err) {
    if (err instanceof BadRequestError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  try {
    const index = await deps.loadIndex(q.key);
    if (!index) return NOT_INDEXED;
    if (!isIndexedPath(index, q.path)) return { status: 404, body: { error: "that file is not part of this index", code: "not_in_index" } };
    const text = await deps.source.getFile(q.key, q.path);
    if (text === null) return { status: 404, body: { error: "the file is not available at this commit", code: "source_unavailable" } };
    const all = splitLines(text);
    if (q.start > all.length) return { status: 400, body: { error: "the line range is outside the file" } };
    const endLine = Math.min(q.end, all.length);
    let truncatedLines = 0;
    const lines = all.slice(q.start - 1, endLine).map((l) => {
      if (l.length <= MAX_LINE_CHARS) return l;
      truncatedLines += 1;
      return l.slice(0, MAX_LINE_CHARS);
    });
    const excerpt: SourceExcerpt = {
      path: q.path,
      startLine: q.start,
      endLine,
      lineCount: all.length,
      lines,
      truncatedLines,
      url: permalink({ repo: q.key, path: q.path, startLine: q.start, endLine }),
    };
    return { status: 200, body: excerpt };
  } catch (err) {
    if (err instanceof GitHubHttpError && (err.status === 403 || err.status === 429)) {
      return { status: 503, body: { error: "source rate limited; retry later", code: "source_rate_limited" } };
    }
    logServerError("source", err);
    return INTERNAL_ERROR;
  }
}
