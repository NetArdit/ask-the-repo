import { loadQuestions, type Split } from "./dataset";
import { scoreQuestion } from "./evaluate";
import { readRun } from "./exp-report";

/** Prints questions whose first-hit rank differs between two runs. Tuning split only (see exp-cli failures). */
const [a, b, split] = process.argv.slice(2) as [string, string, Split | undefined];
if ((split ?? "tuning") !== "tuning") throw new Error("per-question diffs are only available for the tuning split");
const qs = new Map(loadQuestions("tuning").map((q) => [q.id, q]));
const runA = readRun(a, "tuning");
const runB = readRun(b, "tuning");
if (!runA || !runB) throw new Error("missing run file");
const rank = (run: typeof runA) => new Map(run.repos.flatMap((r) => r.questions).map((q) => [q.id, scoreQuestion(qs.get(q.id)!, q.evidence as never).firstHitRank]));
const ra = rank(runA);
const rb = rank(runB);
for (const [id, q] of qs) {
  if (q.expected.length === 0 || ra.get(id) === rb.get(id)) continue;
  console.log(`${id} [${q.category}] ${ra.get(id) ?? "miss"} -> ${rb.get(id) ?? "miss"}  ${q.question}`);
}
