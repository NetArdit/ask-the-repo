import { GitHubRawSource, type SourceProvider } from "../answer/source";
import { CachingSource, FsSourceCache, MemorySourceCache } from "../answer/source-cache";
import { HttpIndexStore } from "../index/http-store";
import { deserializeIndex } from "../index/serialize";
import { LocalFsStore, formatKey, type IndexStore } from "../index/store";
import type { IndexArtifact, IndexKey } from "../index/types";
import { LoadedIndex } from "../retrieve/loaded-index";
import { BoundedStore } from "./bounded-store";
import { logServerError } from "./errors";
import { LatestCommitCache } from "./latest-commit";

let sharedSource: SourceProvider | null = null;

/** Files at a pinned commit never change, so one bounded cache serves every request on this instance, whichever route asks. */
export function getSharedSource(): SourceProvider {
  sharedSource ??= new CachingSource(
    new GitHubRawSource(0),
    process.env.SOURCE_CACHE_DIR ? new FsSourceCache(process.env.SOURCE_CACHE_DIR, 256 * 1024 * 1024) : new MemorySourceCache(32 * 1024 * 1024),
  );
  return sharedSource;
}

const MAX_CACHED_INDEXES = 2;
const cache = new Map<string, LoadedIndex>();
const bootedAt = Date.now();
let served = 0;

/** Where artifacts live is deployment configuration: an HTTP object store when INDEX_STORE_URL is set, otherwise a local directory. */
export function getStore(): IndexStore {
  const url = process.env.INDEX_STORE_URL;
  if (url) return new HttpIndexStore({ baseUrl: url, token: process.env.INDEX_STORE_TOKEN });
  const dir = process.env.INDEX_STORE_DIR;
  if (!dir) throw new Error("Set INDEX_STORE_URL or INDEX_STORE_DIR");
  const mb = Number(process.env.INDEX_STORE_MAX_MB);
  const maxBytes = (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_INDEX_STORE_MB) * 1024 * 1024;
  const id = `${dir}|${maxBytes}`;
  let store = localStores.get(id);
  if (!store) {
    store = new BoundedStore(new LocalFsStore(dir), dir, maxBytes);
    localStores.set(id, store);
  }
  return store;
}

/** A local index folder is a cache of rebuildable artifacts, so it is capped rather than left to fill the disk. */
const DEFAULT_INDEX_STORE_MB = 512;
const localStores = new Map<string, BoundedStore>();

/** Shared by every ingest request on this instance. */
export const latestCommits = new LatestCommitCache();

export interface LoadTimings {
  /** true when the index was already in this instance's memory */
  warmIndex: boolean;
  fetchMs: number;
  deserializeMs: number;
  deriveMs: number;
}

export async function loadCachedIndex(key: IndexKey): Promise<{ index: LoadedIndex; timings: LoadTimings } | null> {
  const id = formatKey(key);
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return { index: hit, timings: { warmIndex: true, fetchMs: 0, deserializeMs: 0, deriveMs: 0 } };
  }
  // Requests for one cold index share a single read and decode; decoding is synchronous work that should not be repeated.
  let pending = loading.get(id);
  if (!pending) {
    pending = readIndex(key, id).finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

const loading = new Map<string, Promise<{ index: LoadedIndex; timings: LoadTimings } | null>>();

async function readIndex(key: IndexKey, id: string): Promise<{ index: LoadedIndex; timings: LoadTimings } | null> {
  const t0 = performance.now();
  const bytes = await getStore().get(key);
  if (!bytes) return null;
  const t1 = performance.now();
  let artifact: IndexArtifact;
  try {
    ({ artifact } = deserializeIndex(bytes));
  } catch (err) {
    // A stored artifact of an older version, or one that is corrupt or oversized, is a cache miss: the commit is reported as not
    // indexed and the next ingest rebuilds it. Treating it as a server error would fail this commit permanently.
    logServerError("index", err);
    return null;
  }
  // An artifact stored under one key but describing another must never answer for it.
  const k = artifact.key;
  if (k.owner.toLowerCase() !== key.owner.toLowerCase() || k.repo.toLowerCase() !== key.repo.toLowerCase() || k.sha !== key.sha) {
    logServerError("index", new Error("stored index does not match the requested key"));
    return null;
  }
  const t2 = performance.now();
  const index = new LoadedIndex(artifact);
  cache.set(id, index);
  while (cache.size > MAX_CACHED_INDEXES) cache.delete(cache.keys().next().value as string);
  return { index, timings: { warmIndex: false, fetchMs: t1 - t0, deserializeMs: t2 - t1, deriveMs: index.deriveMs } };
}

/** Process internals (memory, Node version, uptime) are for development and benchmarks; an anonymous production caller gets nothing. */
export function diagnostics(): { process?: ReturnType<typeof processInfo> } {
  return process.env.NODE_ENV === "production" ? {} : { process: processInfo() };
}

export function processInfo(): { coldStart: boolean; uptimeMs: number; rssMb: number; heapUsedMb: number; node: string } {
  const first = served === 0;
  served += 1;
  const m = process.memoryUsage();
  return { coldStart: first, uptimeMs: Date.now() - bootedAt, rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576), node: process.version };
}
