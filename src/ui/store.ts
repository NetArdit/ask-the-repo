import { parseRepoRef } from "../github/repo-ref";
import type { AnswerResult, ApiFailure } from "./api";

/** A value kept in browser storage and readable with React's useSyncExternalStore. Storage that is missing or blocked behaves as empty. */
export interface ExternalStore<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
  getServerSnapshot(): T;
  set(value: T): void;
}

function createStore<T>(empty: T, read: () => T, write: (value: T) => void): ExternalStore<T> {
  let cache: T | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      if (cache === undefined) {
        try {
          cache = read();
        } catch {
          cache = empty;
        }
      }
      return cache;
    },
    getServerSnapshot: () => empty,
    set(value) {
      cache = value;
      try {
        write(value);
      } catch {
        // Storage full or unavailable: the value still lives for this page view.
      }
      for (const l of listeners) l();
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export interface RecentRepo {
  owner: string;
  repo: string;
  sha: string;
  files: number;
  openedAt: number;
}

const MAX_RECENT = 6;
const NO_RECENTS: RecentRepo[] = [];

/** Stored values are not trusted to be well formed: a recent is kept only if its owner and repo pass the same rules as a typed one. */
function isRepoName(owner: string, repo: string): boolean {
  try {
    parseRepoRef(`${owner}/${repo}`);
    return true;
  } catch {
    return false;
  }
}

export function parseRecents(raw: string | null): RecentRepo[] {
  const data: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(data)) return NO_RECENTS;
  return data
    .filter((r): r is RecentRepo => isObject(r) && typeof r.owner === "string" && typeof r.repo === "string" && typeof r.sha === "string" && /^[0-9a-f]{40}$/.test(r.sha) && isRepoName(r.owner, r.repo) && typeof r.files === "number" && typeof r.openedAt === "number")
    .slice(0, MAX_RECENT);
}

export const recentRepos = createStore<RecentRepo[]>(
  NO_RECENTS,
  () => parseRecents(window.localStorage.getItem("asktherepo.recent")),
  (v) => window.localStorage.setItem("asktherepo.recent", JSON.stringify(v)),
);

export function rememberRepo(entry: Omit<RecentRepo, "openedAt">, now: number): void {
  const rest = recentRepos.getSnapshot().filter((r) => !(r.owner === entry.owner && r.repo === entry.repo && r.sha === entry.sha));
  recentRepos.set([{ ...entry, openedAt: now }, ...rest].slice(0, MAX_RECENT));
}

/** `retryAt` is the time (epoch ms) from which the model said it would accept the question again, when it refused and said so. */
export type Outcome = { kind: "pending" } | { kind: "result"; result: AnswerResult; retryAt?: number } | { kind: "failure"; failure: ApiFailure };

export interface ThreadEntry {
  id: string;
  question: string;
  outcome: Outcome;
}

const MAX_THREAD = 20;
const NO_THREAD: ThreadEntry[] = [];

function isResult(v: unknown): v is AnswerResult {
  return isObject(v) && typeof v.status === "string" && Array.isArray(v.claims) && Array.isArray(v.evidence) && Array.isArray(v.reasons) && Array.isArray(v.warnings) && isObject(v.stats);
}

function parseThread(raw: string | null): ThreadEntry[] {
  const data: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(data)) return NO_THREAD;
  return data.filter((e): e is ThreadEntry => {
    if (!isObject(e) || typeof e.id !== "string" || typeof e.question !== "string" || !isObject(e.outcome)) return false;
    if (e.outcome.kind === "result") return isResult(e.outcome.result);
    return e.outcome.kind === "failure" && isObject(e.outcome.failure) && typeof e.outcome.failure.kind === "string";
  });
}

const threads = new Map<string, ExternalStore<ThreadEntry[]>>();

/** The questions asked about one commit in this browser tab. Kept for the tab's lifetime so a reload or Back does not lose them. */
export function threadStore(owner: string, repo: string, sha: string): ExternalStore<ThreadEntry[]> {
  const key = `asktherepo.thread.${owner}/${repo}@${sha}`;
  let store = threads.get(key);
  if (!store) {
    store = createStore<ThreadEntry[]>(
      NO_THREAD,
      () => parseThread(window.sessionStorage.getItem(key)),
      // A question still waiting for its answer is not saved: after a reload nothing would ever complete it.
      (v) => window.sessionStorage.setItem(key, JSON.stringify(v.filter((e) => e.outcome.kind !== "pending").slice(0, MAX_THREAD))),
    );
    threads.set(key, store);
  }
  return store;
}

/** Links are only ever followed to GitHub, whatever a stored or returned value says. */
export function githubUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && url.startsWith("https://github.com/") ? url : null;
}
