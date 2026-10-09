import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type QuestionCategory =
  | "exact-location"
  | "symbol"
  | "imports"
  | "endpoint"
  | "entry-point"
  | "config"
  | "conceptual"
  | "cross-file"
  | "negative"
  | "adversarial";

export type Split = "tuning" | "holdout";

/** Expected evidence was written by hand or by an independent regex scan of the pinned sources. `lines` omitted means any chunk of the file counts. */
export interface ExpectedEvidence {
  path: string;
  lines?: [number, number];
}

export interface BenchQuestion {
  id: string;
  repo: string;
  category: QuestionCategory;
  question: string;
  /** Empty for negative questions: the repository does not contain an answer. */
  expected: ExpectedEvidence[];
  /** Negative questions only: terms verified absent from every indexable file of the repository. */
  absentTerms?: string[];
}

export interface DatasetRepo {
  repo: string;
  split: Split;
  kind: string;
  language: string;
  sha: string;
}

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dataset/v2");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(DIR, name), "utf8")) as T;
}

export const DATASET_VERSION = "v2";

/** Answer-evaluation facts for a subset of the retrieval questions. Kept apart from the questions so prompts never see them. */
export interface AnswerSpec {
  id: string;
  /** Terms a correct answer is expected to state in its claim text. Empty for questions that must be refused. */
  mentions: string[];
}

export function loadAnswerSpecs(split: Split): AnswerSpec[] {
  return readJson<AnswerSpec[]>(`answers.${split}.json`);
}

export function loadRepos(): DatasetRepo[] {
  return readJson<{ repos: DatasetRepo[] }>("repos.json").repos;
}

export function loadQuestions(split: Split): BenchQuestion[] {
  return readJson<BenchQuestion[]>(`questions.${split}.json`);
}

export function datasetFileHash(name: string): string {
  return createHash("sha256").update(readFileSync(path.join(DIR, name))).digest("hex");
}

export function readLock(): Record<string, string> {
  return readJson<Record<string, string>>("freeze.lock.json");
}

const FROZEN_FILES = ["repos.json", "questions.holdout.json", "fixtures.json", "answers.holdout.json", "support.holdout.json"] as const;

export function createFreezeLock(): Record<string, string> {
  const lock: Record<string, string> = { datasetVersion: DATASET_VERSION, frozenAt: new Date().toISOString() };
  for (const f of FROZEN_FILES) lock[f] = datasetFileHash(f);
  return lock;
}

/** Throws if the holdout questions, pinned SHAs or fixtures changed after the freeze. */
export function assertFrozen(): void {
  const lock = readLock();
  for (const f of FROZEN_FILES) {
    if (lock[f] !== datasetFileHash(f)) throw new Error(`Frozen dataset file changed after freeze: ${f}`);
  }
}
