import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepoRef } from "../github/repo-ref";
import { ensureTarball } from "./cache";
import { assertFrozen, createFreezeLock, loadQuestions, loadRepos, type Split } from "./dataset";
import { validateAll } from "./validate-dataset";
import { runRepo, type RepoRun } from "./experiment";
import { resolveSpec } from "./experiments";
import { METRIC_HEAD, RUN_DIR, metricsRow, readRun, runPath, scoreFixture, scoreRun, table, type RunFile } from "./exp-report";
import { scoreQuestion } from "./evaluate";
import { analyzeFlow } from "./flow-analysis";
import { runAbstention } from "./abstention";
import { runMatrix, runStage, type Mode, type Stage } from "./memory-experiment";
import { selectProvider } from "../server/answer-handler";
import { githubSourceCheck, viewLines } from "./answer-eval";
import { evaluateJudge, exportReview, reviewStatus, validateSupportSet } from "./support";
import { runSemanticAttacks } from "./semantic-attacks";
import { runSourceCacheBench } from "./source-cache-bench";
import { runInjectionSuite } from "./injection-suite";
import { POLICY_GRID, baselineProvider, evidenceVersionFromArgs, runAnswers, saveRun, scoreAnswers, tuningRunNames, variantFromArgs, type AnswerRun, type EvidenceVersion } from "./answer-eval";
import type { PromptVariant } from "../answer/prompt";
import { getRepo, putRepo, withStoreServer } from "./storage-spike";
import { FIXTURE_REPO, runFixture } from "./fixtures";

// --liftoff-only avoids the V8 "Zone" out-of-memory crash seen at process exit with WASM grammars (see Phase 1 report).
const CHILD_FLAGS = ["--max-old-space-size=2048", "--liftoff-only"];
const SELF = fileURLToPath(import.meta.url);

function child<T>(args: string[]): T {
  const res = spawnSync(process.execPath, [...CHILD_FLAGS, "--import", "tsx", SELF, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`child ${args.join(" ")} failed (${res.status}): ${(res.stderr || res.stdout).slice(-1500)}`);
  return JSON.parse(res.stdout.trim().split("\n").pop() ?? "null") as T;
}

/** Async variant: the in-process store server must keep serving while the child runs. */
function childAsync<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...CHILD_FLAGS, "--import", "tsx", SELF, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`child failed (${code}): ${err.slice(-1500)}`));
      else resolve(JSON.parse(out.trim().split("\n").pop() ?? "null") as T);
    });
  });
}

function orchestrate(specName: string, splits: Split[]): void {
  const spec = resolveSpec(specName);
  mkdirSync(RUN_DIR, { recursive: true });
  for (const split of splits) {
    if (split === "holdout") assertFrozen();
    const repos: RepoRun[] = loadRepos()
      .filter((r) => r.split === split)
      .map((r) => {
        process.stderr.write(`  ${spec.name} ${split} ${r.repo}\n`);
        return child<RepoRun>(["repo", r.repo, spec.name]);
      });
    const run: RunFile = { spec: spec.name, description: spec.description, split, createdAt: new Date().toISOString(), repos };
    if (split === "tuning") run.fixture = child(["repo", FIXTURE_REPO, spec.name]);
    writeFileSync(runPath(spec.name, split), JSON.stringify(run));
  }
}

async function commandRepo(repoName: string, specName: string): Promise<void> {
  const spec = resolveSpec(specName);
  if (repoName === FIXTURE_REPO) {
    process.stdout.write(`${JSON.stringify(await runFixture(spec))}\n`);
    return;
  }
  const repo = loadRepos().find((r) => r.repo === repoName);
  if (!repo) throw new Error(`Unknown repo ${repoName}`);
  const questions = loadQuestions(repo.split).filter((q) => q.repo === repoName);
  process.stdout.write(`${JSON.stringify(await runRepo(repo, spec, questions))}\n`);
}

function report(specs: string[]): void {
  for (const split of ["tuning", "holdout"] as Split[]) {
    const rows: string[][] = [];
    for (const name of specs) {
      const run = readRun(name, split);
      if (!run) continue;
      const s = scoreRun(run);
      rows.push(metricsRow(name, s.overall, s.medianLatencyMs));
    }
    if (rows.length > 0) console.log(`\n### ${split}\n\n${table(METRIC_HEAD, rows)}`);
  }
  for (const name of specs) {
    const run = readRun(name, "tuning");
    if (run?.fixture) console.log(`\nfixture ${name}: ${scoreFixture(run.fixture).map((f) => `${f.id}=${f.pass ? "pass" : "FAIL"}(${f.top1})`).join(" ")}`);
  }
}

/** Per-question detail. Tuning split only: holdout questions are never inspected individually while tuning. */
function failures(specName: string, categoryFilter: string | undefined, all: boolean): void {
  const run = readRun(specName, "tuning");
  if (!run) throw new Error(`no tuning run for ${specName}`);
  const qs = new Map(loadQuestions("tuning").map((q) => [q.id, q]));
  for (const repo of run.repos) {
    for (const q of repo.questions) {
      const question = qs.get(q.id)!;
      if (categoryFilter && q.category !== categoryFilter) continue;
      const score = scoreQuestion(question, q.evidence as never);
      if (!all && (score.negative || score.hitAtK[5])) continue;
      console.log(`${q.id} [${q.category}] rank=${score.firstHitRank ?? "miss"} ${question.question}`);
      console.log(`   expected: ${question.expected.map((e) => e.path + (e.lines ? `:${e.lines[0]}-${e.lines[1]}` : "")).join(", ") || "(none)"}`);
      for (const e of q.evidence.slice(0, 4)) console.log(`   ${e.path}:${e.startLine}-${e.endLine} s=${e.score.toFixed(2)} bm25=${e.signals.bm25.toFixed(2)} sym=${e.signals.symbol.toFixed(2)} path=${e.signals.path.toFixed(2)}`);
    }
  }
}

/** Storage spike: build+upload in one process, fetch+load+retrieve in a fresh process, for each repository. */
async function storageSpike(repos: string[], latencyMs: number, bytesPerSecond: number): Promise<void> {
  await withStoreServer({ latencyMs, bytesPerSecond }, async (url) => {
    const rows: Record<string, unknown>[] = [];
    for (const repo of repos) {
      const put = await childAsync<Awaited<ReturnType<typeof putRepo>>>(["storage-put", repo, url]);
      const get = await childAsync<Awaited<ReturnType<typeof getRepo>>>(["storage-get", repo, url]);
      rows.push({ ...put, ...get });
    }
    console.log(JSON.stringify({ emulated: { latencyMs, bytesPerSecond }, rows }));
  });
}

/** Runs the answer pipeline with the deterministic baseline model over a grid of abstention policies. */
async function answerGrid(splits: Split[]): Promise<void> {
  for (const split of splits) {
    for (const [lo, hi] of POLICY_GRID) {
      for (const declines of [false, true]) {
        if (lo === hi && declines) continue;
        const name = `p${lo}-${hi}${declines ? "-declines" : ""}`;
        const run: AnswerRun = await runAnswers(split, { name, policy: { insufficientBelow: lo, cautionBelow: hi }, captionDeclines: declines }, baselineProvider);
        saveRun(run);
        const m = scoreAnswers(run.records);
        console.log(JSON.stringify({ split, name, positivesAnswered: m.positivesAnswered, positivesRefused: m.positivesRefused, negativesRefused: m.negativesRefused, negativesAnswered: m.negativesAnswered, correct: m.correct }));
      }
    }
  }
}

/**
 * One answer run with the provider chosen by server configuration (GROQ_API_KEY plus GROQ_MODEL).
 * It sends repository excerpts to the provider, so it refuses to run on the frozen holdout unless --final is given: prompts must be
 * settled on the tuning split first. The provider is rate-limit aware and every completed case is checkpointed, so an interrupted or
 * quota-stopped run resumes where it stopped without repeating model calls; a partial run is reported, never saved or scored as a whole.
 */
async function answerRun(split: Split, lo: number, hi: number, promptVariant: PromptVariant, evidenceVersion: EvidenceVersion): Promise<void> {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error("answer-run thresholds must be numbers");
  const provider = selectProvider(process.env, { paced: true });
  if (!provider) throw new Error("No model provider configured: set GROQ_API_KEY plus GROQ_MODEL. Real-model evaluation is OPEN until then.");
  if (split === "holdout" && provider.name !== "extractive-baseline" && !process.argv.includes("--final")) {
    throw new Error("Refusing a real-model run on the frozen holdout without --final.");
  }
  const names = tuningRunNames(split, lo, hi, process.env.GROQ_MODEL ?? "model", promptVariant, evidenceVersion);
  const checkpointFile = path.resolve(path.dirname(SELF), "../../reports/phase3/checkpoints", names.checkpointName);
  // Raw model replies and quotes can contain third-party source, so they go to a folder git ignores.
  const privateFile = path.resolve(path.dirname(SELF), "../../reports/private/phase4b", names.privateName);
  const run = await runAnswers(split, { name: names.variantName, policy: { insufficientBelow: lo, cautionBelow: hi }, captionDeclines: false }, () => provider, { checkpointFile, privateFile, model: process.env.GROQ_MODEL, modelTimeoutMs: 400_000, promptVariant, evidenceVersion });
  const summary = { promptVariant, evidenceVersion, evidenceContract: run.evidenceContract, completed: run.records.length, total: run.total, resumedFromCheckpoint: run.resumed, providerFailures: run.providerFailures, halted: run.halted ?? null, checkpointFile };
  if (run.halted || (run.providerFailures?.length ?? 0) > 0) {
    console.log(JSON.stringify({ status: "PARTIAL: not saved, not scored. Re-run the same command to resume.", ...summary }, null, 1));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ file: saveRun(run), ...summary, metrics: scoreAnswers(run.records) }, null, 1));
}

const [command, a, b] = process.argv.slice(2);
if (command === "run") {
  const splits = (b ?? "tuning").split(",") as Split[];
  orchestrate(a!, splits);
} else if (command === "repo") await commandRepo(a!, b!);
else if (command === "flow") console.log(JSON.stringify(await analyzeFlow(a!), null, 2));
else if (command === "abstain") console.log(runAbstention(a ?? "accepted"));
else if (command === "storage-put") console.log(JSON.stringify(await putRepo(a!, b!)));
else if (command === "storage-get") console.log(JSON.stringify(await getRepo(a!, b!)));
else if (command === "storage") await storageSpike((a ?? "sindresorhus/ky,vitejs/vite,facebook/react,excalidraw/excalidraw").split(","), Number(b ?? 0), Number(process.argv[5] ?? 0));
else if (command === "mem-stage") console.log(JSON.stringify(await runStage(a!, b as Stage, process.argv[5] as Mode)));
else if (command === "mem") console.log(JSON.stringify(runMatrix(a!.split(","), (b ?? "full").split(",") as Stage[], (process.argv[5] ?? "default,liftoff-flag").split(",") as Mode[]), null, 1));
else if (command === "validate") await validateAll();
else if (command === "prepare") for (const r of loadRepos()) console.error(`${r.repo}: ${await ensureTarball(parseRepoRef(r.repo), r.sha)}`);
else if (command === "freeze") {
  writeFileSync(path.resolve(path.dirname(SELF), "dataset/v2/freeze.lock.json"), `${JSON.stringify(createFreezeLock(), null, 2)}
`);
  console.error("froze holdout");
} else if (command === "answer-grid") await answerGrid((a ?? "tuning").split(",") as Split[]);
else if (command === "inject-suite") console.log(JSON.stringify(await runInjectionSuite(), null, 1));
else if (command === "github-source-check") console.log(JSON.stringify(await githubSourceCheck(a!, (b ?? "").split(",")), null, 1));
else if (command === "answer-run") {
  // answer-run <split> [lo] [hi] [--variant=A|B|C|D|E] [--evidence=v2|v3] [--final]: flags may appear anywhere and are never read as numbers.
  const variant = variantFromArgs(process.argv.slice(3));
  const evidenceVersion = evidenceVersionFromArgs(process.argv.slice(3));
  const pos = process.argv.slice(3).filter((x) => !x.startsWith("--"));
  await answerRun((pos[0] ?? "tuning") as Split, Number(pos[1] ?? 0.3), Number(pos[2] ?? 0.5), variant, evidenceVersion);
}
else if (command === "view") console.log(await viewLines(a!, b!, Number(process.argv[5]), Number(process.argv[6])));
else if (command === "support-validate") {
  const problems = await validateSupportSet();
  console.log(problems.length === 0 ? "support set ok" : problems.join("\n"));
  if (problems.length > 0) process.exitCode = 1;
} else if (command === "judge-eval") {
  const provider = selectProvider(process.env);
  if (!provider || provider.name === "extractive-baseline") throw new Error("A real judge needs a configured provider (GROQ_API_KEY plus GROQ_MODEL). Judge evaluation is OPEN until then.");
  if (a === "holdout" && !process.argv.includes("--final")) throw new Error("Refusing a real-model run on the frozen holdout without --final.");
  console.log(JSON.stringify(await evaluateJudge(provider, (a ?? "tuning") as Split), null, 1));
} else if (command === "semantic-attacks") {
  const provider = selectProvider(process.env, { paced: true });
  if (!provider) throw new Error("No provider configured; real-model semantic attacks are OPEN.");
  console.log(JSON.stringify({ provider: provider.name, variant: a ?? "A", outcomes: await runSemanticAttacks(provider, (a ?? "A") as "A" | "B" | "C") }, null, 1));
} else if (command === "source-cache-bench") console.log(JSON.stringify(await runSourceCacheBench(Number(a ?? 120)), null, 1));
else if (command === "support-review-export") {
  // The export quotes third-party source for the reviewer, so it is written under reports/private/, which git ignores.
  const file = path.resolve(path.dirname(SELF), "../../reports/private/phase4b-support-review.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await exportReview());
  console.error(`wrote ${file}`);
} else if (command === "support-review-status") {
  const s = reviewStatus();
  console.log([`${s.reviewed} of ${s.total} reviewed`, ...(s.problems.length ? ["problems:", ...s.problems] : [])].join("\n"));
  if (s.problems.length > 0) process.exitCode = 1;
} else if (command === "report") report(process.argv.slice(3));
else if (command === "failures") failures(a!, b, process.argv.includes("--all"));
else {
  console.error("usage: exp-cli.ts prepare | validate | freeze | run <spec> [tuning|holdout|tuning,holdout] | report <spec...> | failures <spec> | abstain <spec> | flow <repo> | storage | mem");
  process.exitCode = 2;
}

