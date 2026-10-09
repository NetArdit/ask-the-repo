import { createHash } from "node:crypto";
import path from "node:path";
import { parseRepoRef } from "../github/repo-ref";
import type { EntryStats, ImportStats } from "../index/build";
import { buildIndexFromTarball } from "../index/from-tarball";
import { LocalFsStore } from "../index/store";
import type { IndexConfig } from "../index/types";
import { BASELINE_CONFIG } from "../index/types";
import { LoadedIndex } from "../retrieve/loaded-index";
import { search, type AbstentionFeatures, type Evidence, type SearchOptions } from "../retrieve/search";
import { deserializeIndex } from "../index/serialize";
import { CACHE_ROOT, ensureTarball, openCachedTarball } from "./cache";
import type { BenchQuestion, DatasetRepo } from "./dataset";
import { median } from "./evaluate";

export interface ExperimentSpec {
  name: string;
  description: string;
  index: IndexConfig;
  search: SearchOptions;
}

export const CONTROL_SPEC: ExperimentSpec = { name: "control", description: "Phase 1 retrieval on the Phase 2 dataset", index: BASELINE_CONFIG, search: {} };

export function indexConfigKey(config: IndexConfig): string {
  return createHash("sha1").update(JSON.stringify(config)).digest("hex").slice(0, 10);
}

export interface RepoBuildSummary {
  cached: boolean;
  ms: number;
  files: number;
  chunks: number;
  artifactBytes: number;
  parseStatus: Record<string, Record<string, number>>;
  parseFallbackReasons: Record<string, number>;
  imports: ImportStats;
  entries: EntryStats;
}

function storeFor(config: IndexConfig): LocalFsStore {
  return new LocalFsStore(path.join(CACHE_ROOT, "index", indexConfigKey(config)));
}

/** Builds (or reuses) the index of one pinned repository under one index configuration. Reads only the cached tarball. */
export async function ensureRepoIndex(repo: DatasetRepo, config: IndexConfig, force = process.env.ATR_FORCE === "1"): Promise<RepoBuildSummary> {
  const ref = parseRepoRef(repo.repo);
  const key = { ...ref, sha: repo.sha };
  const store = storeFor(config);
  const summaryFile = path.join(CACHE_ROOT, "index", indexConfigKey(config), `${ref.owner}__${ref.repo}.summary.json`);
  const fs = await import("node:fs/promises");
  if (!force) {
    try {
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as RepoBuildSummary;
      if (await store.get(key)) return { ...summary, cached: true };
    } catch {
      // not built yet
    }
  }
  const built = await buildRepoArtifact(repo, config);
  await store.put(key, built.bytes);
  const summary = { ...built.summary, cached: false };
  await fs.mkdir(path.dirname(summaryFile), { recursive: true });
  await fs.writeFile(summaryFile, JSON.stringify(summary));
  return summary;
}

/** Builds and serializes the index of one pinned repository from the cached tarball. Storing the bytes is the caller's job. */
export async function buildRepoArtifact(repo: DatasetRepo, config: IndexConfig): Promise<{ bytes: Buffer; summary: RepoBuildSummary }> {
  const ref = parseRepoRef(repo.repo);
  const started = performance.now();
  const tarball = await ensureTarball(ref, repo.sha);
  const built = await buildIndexFromTarball(openCachedTarball(tarball), { ...ref, sha: repo.sha }, config);
  const summary: RepoBuildSummary = {
    cached: false,
    ms: performance.now() - started,
    files: built.files,
    chunks: built.chunks,
    artifactBytes: built.bytes.length,
    parseStatus: built.parseStatus,
    parseFallbackReasons: built.parseFallbackReasons,
    imports: built.imports,
    entries: built.entries,
  };
  return { bytes: built.bytes, summary };
}

export interface QuestionRun {
  id: string;
  category: string;
  split: string;
  negative: boolean;
  evidence: Pick<Evidence, "path" | "startLine" | "endLine" | "score" | "signals">[];
  features: AbstentionFeatures;
  latencyMs: number;
}

export interface RepoRun {
  repo: string;
  split: string;
  build: RepoBuildSummary;
  loadMs: number;
  questions: QuestionRun[];
}

/** One repository, one spec: build if needed, load the artifact, answer every question of that repository. */
export async function runRepo(repo: DatasetRepo, spec: ExperimentSpec, questions: BenchQuestion[]): Promise<RepoRun> {
  const build = await ensureRepoIndex(repo, spec.index);
  const ref = parseRepoRef(repo.repo);
  const t0 = performance.now();
  const bytes = await storeFor(spec.index).get({ ...ref, sha: repo.sha });
  if (!bytes) throw new Error(`index missing for ${repo.repo}`);
  const index = new LoadedIndex(deserializeIndex(bytes).artifact);
  const loadMs = performance.now() - t0;
  const runs: QuestionRun[] = questions.map((q) => {
    const first = search(index, q.question, { ...spec.search, k: 10 });
    const latencies = [first.latencyMs, ...Array.from({ length: 2 }, () => search(index, q.question, { ...spec.search, k: 10 }).latencyMs)];
    return {
      id: q.id,
      category: q.category,
      split: repo.split,
      negative: q.expected.length === 0,
      evidence: first.evidence.map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine, score: e.score, signals: e.signals })),
      features: first.features,
      latencyMs: median(latencies),
    };
  });
  return { repo: repo.repo, split: repo.split, build, loadMs, questions: runs };
}

