import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IndexBuilder } from "../index/build";
import { languageOf } from "../ingest/filter";
import { parseSource } from "../parse/extract";
import { LoadedIndex } from "../retrieve/loaded-index";
import { search } from "../retrieve/search";
import type { ExperimentSpec, QuestionRun } from "./experiment";
import type { BenchQuestion } from "./dataset";

interface FixtureFile {
  repo: string;
  files: Record<string, string>;
  questions: { id: string; category: "adversarial"; question: string; expected: { path: string }[] }[];
}

export const FIXTURE_REPO = "fixture/adversarial";

export function loadFixture(): FixtureFile {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dataset/v2/fixtures.json");
  return JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
}

export function fixtureQuestions(): BenchQuestion[] {
  return loadFixture().questions.map((q) => ({ ...q, repo: FIXTURE_REPO }));
}

/** Builds the synthetic hostile repository in memory and answers its questions. Hostile text is only ever indexed as terms. */
export async function runFixture(spec: ExperimentSpec): Promise<QuestionRun[]> {
  const fixture = loadFixture();
  const builder = new IndexBuilder({ owner: "fixture", repo: "adversarial", sha: "f".repeat(40) }, spec.index);
  for (const [p, text] of Object.entries(fixture.files)) {
    builder.addFile(await parseSource(p, languageOf(p), text, { variant: spec.index.parseVariant }), text, Buffer.byteLength(text));
  }
  const index = new LoadedIndex(builder.finish());
  return fixture.questions.map((q) => {
    const r = search(index, q.question, { ...spec.search, k: 10 });
    return {
      id: q.id,
      category: q.category,
      split: "fixture",
      negative: q.expected.length === 0,
      evidence: r.evidence.map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine, score: e.score, signals: e.signals })),
      features: r.features,
      latencyMs: r.latencyMs,
    };
  });
}
