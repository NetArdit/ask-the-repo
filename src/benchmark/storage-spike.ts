import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpIndexStore } from "../index/http-store";
import { deserializeIndex } from "../index/serialize";
import { LoadedIndex } from "../retrieve/loaded-index";
import { search } from "../retrieve/search";
import { parseRepoRef } from "../github/repo-ref";
import { loadQuestions, loadRepos } from "./dataset";
import { buildRepoArtifact } from "./experiment";
import { resolveSpec } from "./experiments";
import { currentRssMb, peakRssMb } from "./process-memory";
import { startStoreServer } from "./store-server";

export interface PutResult {
  repo: string;
  buildMs: number;
  artifactBytes: number;
  uploadMs: number;
  peakRssMb: number;
}

export interface GetResult {
  repo: string;
  fetchMs: number;
  decompressMs: number;
  jsonParseMs: number;
  deriveMs: number;
  firstQueryMs: number;
  secondQueryMs: number;
  loadTotalMs: number;
  rssBeforeMb: number;
  rssAfterLoadMb: number;
  peakRssMb: number;
}

/** Process A: build the index and upload the artifact to the store. */
export async function putRepo(repoName: string, baseUrl: string): Promise<PutResult> {
  const repo = loadRepos().find((r) => r.repo === repoName);
  if (!repo) throw new Error(`unknown repo ${repoName}`);
  const spec = resolveSpec("accepted");
  const t0 = performance.now();
  const built = await buildRepoArtifact(repo, spec.index);
  const buildMs = performance.now() - t0;
  const store = new HttpIndexStore({ baseUrl });
  const t1 = performance.now();
  await store.put({ ...parseRepoRef(repoName), sha: repo.sha }, built.bytes);
  return { repo: repoName, buildMs, artifactBytes: built.bytes.length, uploadMs: performance.now() - t1, peakRssMb: peakRssMb() };
}

/** Process B: a new process that only knows the store URL and the repository key. */
export async function getRepo(repoName: string, baseUrl: string): Promise<GetResult> {
  const repo = loadRepos().find((r) => r.repo === repoName)!;
  const spec = resolveSpec("accepted");
  const question = loadQuestions(repo.split).find((q) => q.repo === repoName && q.expected.length > 0)!.question;
  const rssBeforeMb = currentRssMb();
  const store = new HttpIndexStore({ baseUrl });
  const t0 = performance.now();
  const bytes = await store.get({ ...parseRepoRef(repoName), sha: repo.sha });
  if (!bytes) throw new Error("artifact not found");
  const fetchMs = performance.now() - t0;
  const { artifact, decompressMs, parseMs } = deserializeIndex(bytes);
  const index = new LoadedIndex(artifact);
  const loadTotalMs = performance.now() - t0;
  const first = search(index, question, { ...spec.search, k: 10 });
  const second = search(index, question, { ...spec.search, k: 10 });
  return {
    repo: repoName,
    fetchMs,
    decompressMs,
    jsonParseMs: parseMs,
    deriveMs: index.deriveMs,
    firstQueryMs: first.latencyMs,
    secondQueryMs: second.latencyMs,
    loadTotalMs,
    rssBeforeMb,
    rssAfterLoadMb: currentRssMb(),
    peakRssMb: peakRssMb(),
  };
}

export async function withStoreServer<T>(
  options: { latencyMs?: number; bytesPerSecond?: number },
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "atr-store-"));
  const { server, url } = await startStoreServer({ dir, ...options });
  try {
    return await fn(url);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}
