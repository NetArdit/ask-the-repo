import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadQuestions, type BenchQuestion, type Split } from "./dataset";
import { aggregate, median, scoreQuestion, type Aggregate, type QuestionScore } from "./evaluate";
import type { QuestionRun, RepoRun } from "./experiment";
import { fixtureQuestions } from "./fixtures";

export const RUN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../reports/phase2/runs");

export interface RunFile {
  spec: string;
  description: string;
  split: Split;
  createdAt: string;
  repos: RepoRun[];
  fixture?: QuestionRun[];
}

export function runPath(spec: string, split: Split): string {
  return path.join(RUN_DIR, `${spec}.${split}.json`);
}

export function readRun(spec: string, split: Split): RunFile | null {
  const file = runPath(spec, split);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunFile) : null;
}

export function questionsById(split: Split): Map<string, BenchQuestion> {
  return new Map(loadQuestions(split).map((q) => [q.id, q]));
}

export function scoreRun(run: RunFile): { scores: QuestionScore[]; byCategory: Map<string, Aggregate>; overall: Aggregate; medianLatencyMs: number; byRepo: Map<string, Aggregate> } {
  const qs = questionsById(run.split);
  const scores: QuestionScore[] = [];
  const repoOf = new Map<string, string>();
  for (const r of run.repos) {
    for (const q of r.questions) {
      const question = qs.get(q.id);
      if (!question) throw new Error(`Unknown question ${q.id}`);
      scores.push(scoreQuestion(question, q.evidence as never));
      repoOf.set(q.id, r.repo);
    }
  }
  const byCategory = new Map<string, Aggregate>();
  for (const cat of new Set(scores.map((s) => s.category))) byCategory.set(cat, aggregate(scores.filter((s) => s.category === cat)));
  const byRepo = new Map<string, Aggregate>();
  for (const repo of new Set(repoOf.values())) byRepo.set(repo, aggregate(scores.filter((s) => repoOf.get(s.id) === repo)));
  const latencies = run.repos.flatMap((r) => r.questions.map((q) => q.latencyMs));
  return { scores, byCategory, overall: aggregate(scores), medianLatencyMs: median(latencies), byRepo };
}

export function scoreFixture(run: QuestionRun[]): { id: string; pass: boolean; top1: string }[] {
  const qs = new Map(fixtureQuestions().map((q) => [q.id, q]));
  return run.map((r) => {
    const q = qs.get(r.id)!;
    const s = scoreQuestion(q, r.evidence as never);
    // Positives must have the real file at rank 1. Negatives and the injected query have no real answer; they "pass" only
    // if no hostile file is ranked first (the abstention experiment decides what to do with the rest).
    const top1 = r.evidence[0]?.path ?? "(none)";
    const hostile = ["README.md", "src/evil.ts", "src/util/stuffed.ts"].includes(top1);
    return { id: r.id, pass: q.expected.length > 0 ? s.firstHitRank === 1 : !hostile, top1 };
  });
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

export function metricsRow(label: string, a: Aggregate, latency: number): string[] {
  return [label, String(a.questions), pct(a.hitAtK[1]!), pct(a.hitAtK[3]!), pct(a.hitAtK[5]!), pct(a.hitAtK[10]!), a.mrr.toFixed(2), a.precisionAt5.toFixed(2), latency.toFixed(1)];
}

export const METRIC_HEAD = ["run", "n", "hit@1", "hit@3", "hit@5", "hit@10", "MRR", "p@5", "median ms"];

export function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
