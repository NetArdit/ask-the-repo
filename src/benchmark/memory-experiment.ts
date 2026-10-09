import { spawnSync } from "node:child_process";
import { setFlagsFromString } from "node:v8";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { parseRepoRef } from "../github/repo-ref";
import { buildIndexFromTarball } from "../index/from-tarball";
import { DEFAULT_LIMITS, ingestTarGz } from "../ingest/tarball";
import { parseSource } from "../parse/extract";
import { DEFAULT_INDEX_CONFIG } from "../retrieve/defaults";
import { ensureTarball, openCachedTarball } from "./cache";
import { loadRepos } from "./dataset";

export type Stage = "stream" | "parse" | "full";
export type Mode = "default" | "liftoff-flag" | "liftoff-runtime" | "heap-512";

const MODE_FLAGS: Record<Mode, string[]> = {
  default: [],
  "liftoff-flag": ["--liftoff-only"],
  // The flag is applied from inside the process, before the first grammar loads: the only form available where Node options cannot be set.
  "liftoff-runtime": [],
  "heap-512": ["--max-old-space-size=512"],
};

export interface MemoryResult {
  repo: string;
  stage: Stage;
  mode: Mode;
  ms: number;
  maxRssMb: number;
  rssAtEndMb: number;
  heapUsedAtEndMb: number;
  files: number;
}

const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;

/** Runs one stage in this process and reports its memory. The orchestrator runs each combination in a fresh process. */
export async function runStage(repoName: string, stage: Stage, mode: Mode): Promise<MemoryResult> {
  if (mode === "liftoff-runtime") setFlagsFromString("--liftoff-only");
  const repo = loadRepos().find((r) => r.repo === repoName);
  if (!repo) throw new Error(`unknown repo ${repoName}`);
  const ref = parseRepoRef(repoName);
  const source = openCachedTarball(await ensureTarball(ref, repo.sha)) as Readable;
  const t0 = performance.now();
  let files = 0;
  if (stage === "stream") {
    await ingestTarGz(source, DEFAULT_LIMITS, () => void (files += 1), { includeConfig: true });
  } else if (stage === "parse") {
    await ingestTarGz(
      source,
      DEFAULT_LIMITS,
      async (f) => {
        if (f.language === "config") return;
        await parseSource(f.path, f.language, f.content.toString("utf8"), { variant: DEFAULT_INDEX_CONFIG.parseVariant });
        files += 1;
      },
      { includeConfig: true },
    );
  } else {
    files = (await buildIndexFromTarball(source, { ...ref, sha: repo.sha }, DEFAULT_INDEX_CONFIG)).files;
  }
  const m = process.memoryUsage();
  return { repo: repoName, stage, mode, ms: performance.now() - t0, maxRssMb: mb(process.resourceUsage().maxRSS * 1024), rssAtEndMb: mb(m.rss), heapUsedAtEndMb: mb(m.heapUsed), files };
}

export function runMatrix(repos: string[], stages: Stage[], modes: Mode[]): (MemoryResult | { repo: string; stage: Stage; mode: Mode; failed: string })[] {
  const self = fileURLToPath(new URL("./exp-cli.ts", import.meta.url));
  const out: (MemoryResult | { repo: string; stage: Stage; mode: Mode; failed: string })[] = [];
  for (const repo of repos) {
    for (const stage of stages) {
      for (const mode of modes) {
        const res = spawnSync(process.execPath, [...MODE_FLAGS[mode], "--import", "tsx", self, "mem-stage", repo, stage, mode], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const line = res.stdout.trim().split("\n").pop() ?? "";
        if (res.status === 0 && line.startsWith("{")) out.push(JSON.parse(line) as MemoryResult);
        else out.push({ repo, stage, mode, failed: `exit ${res.status}: ${(res.stderr || "").trim().split("\n").filter((l) => /Fatal|Error/.test(l)).slice(0, 2).join(" | ")}` });
        process.stderr.write(`${repo} ${stage} ${mode} -> ${JSON.stringify(out[out.length - 1])}\n`);
      }
    }
  }
  return out;
}
