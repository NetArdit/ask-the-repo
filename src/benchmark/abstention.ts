import { loadQuestions, type Split } from "./dataset";
import { scoreQuestion } from "./evaluate";
import { readRun, table } from "./exp-report";
import type { AbstentionFeatures } from "../retrieve/search";

interface Row {
  split: Split;
  id: string;
  /** Task A: the repository has no answer at all. */
  negative: boolean;
  /** Task B: the retrieved evidence would not support an answer (negative, or expected evidence not in the top 5). */
  unsupported: boolean;
  f: AbstentionFeatures;
}

type Rule = { name: string; abstain: (f: AbstentionFeatures, t: number[]) => boolean; grids: number[][] };

const RULES: Rule[] = [
  { name: "topScore < t", abstain: (f, [t]) => f.topScore < t!, grids: [[0.3, 0.5, 0.7, 0.9, 1.1, 1.3]] },
  { name: "idfCoverage < t", abstain: (f, [t]) => f.idfCoverage < t!, grids: [[0.2, 0.35, 0.5, 0.65, 0.8]] },
  { name: "top1Coverage < t", abstain: (f, [t]) => f.top1Coverage < t!, grids: [[0.2, 0.35, 0.5, 0.65, 0.8]] },
  { name: "margin < t", abstain: (f, [t]) => f.margin < t!, grids: [[0.02, 0.05, 0.1, 0.2]] },
  {
    name: "no structural support and top1Coverage < t",
    abstain: (f, [t]) => !f.exactSymbolInTop3 && !f.pathHitTop1 && f.top1Coverage < t!,
    grids: [[0.35, 0.5, 0.65, 0.8, 1.01]],
  },
  {
    name: "idfCoverage < a OR topScore < b",
    abstain: (f, [a, b]) => f.idfCoverage < a! || f.topScore < b!,
    grids: [[0.35, 0.5, 0.65], [0.3, 0.5, 0.7]],
  },
];

function rowsFor(spec: string, split: Split): Row[] {
  const run = readRun(spec, split);
  if (!run) throw new Error(`missing run ${spec}.${split}`);
  const qs = new Map(loadQuestions(split).map((q) => [q.id, q]));
  return run.repos.flatMap((r) =>
    r.questions.map((q) => {
      const question = qs.get(q.id)!;
      const s = scoreQuestion(question, q.evidence as never);
      return { split, id: q.id, negative: s.negative, unsupported: s.negative || !s.hitAtK[5], f: q.features };
    }),
  );
}

function combos(grids: number[][]): number[][] {
  return grids.reduce<number[][]>((acc, g) => acc.flatMap((a) => g.map((v) => [...a, v])), [[]]);
}

interface Confusion {
  tp: number; // should abstain, did
  fn: number; // should abstain, answered (harmful)
  fp: number; // should answer, abstained (over-refusal)
  tn: number;
}

function confuse(rows: Row[], rule: Rule, t: number[], label: (r: Row) => boolean): Confusion {
  const c: Confusion = { tp: 0, fn: 0, fp: 0, tn: 0 };
  for (const r of rows) {
    const should = label(r);
    const did = rule.abstain(r.f, t);
    if (should && did) c.tp++;
    else if (should) c.fn++;
    else if (did) c.fp++;
    else c.tn++;
  }
  return c;
}

const balanced = (c: Confusion): number => (c.tp / Math.max(1, c.tp + c.fn) + c.tn / Math.max(1, c.tn + c.fp)) / 2;
const cell = (c: Confusion): string => `TP ${c.tp} / FN ${c.fn} / FP ${c.fp} / TN ${c.tn}`;

/** Chooses each rule's threshold on tuning only, then reports the same threshold on holdout. */
export function runAbstention(spec: string): string {
  const tuning = rowsFor(spec, "tuning");
  const holdout = rowsFor(spec, "holdout");
  const out: string[] = [];
  for (const [task, label] of [
    ["A: abstain when the repository has no answer (negatives)", (r: Row) => r.negative],
    ["B: abstain when the evidence would not support an answer (negatives + retrieval misses at top-5)", (r: Row) => r.unsupported],
  ] as const) {
    const base = (rows: Row[]) => rows.filter(label).length;
    out.push(`\n#### Task ${task}\n\ntuning: ${base(tuning)} should-abstain of ${tuning.length}; holdout: ${base(holdout)} of ${holdout.length}\n`);
    const rows: string[][] = [];
    for (const rule of RULES) {
      let best: { t: number[]; c: Confusion; score: number } | null = null;
      for (const t of combos(rule.grids)) {
        const c = confuse(tuning, rule, t, label);
        // Prefer fewer over-refusals when balanced accuracy ties.
        const score = balanced(c) - 0.001 * c.fp;
        if (!best || score > best.score) best = { t, c, score };
      }
      const h = confuse(holdout, rule, best!.t, label);
      rows.push([rule.name, best!.t.join(", "), cell(best!.c), `${(balanced(best!.c) * 100).toFixed(0)}%`, cell(h), `${(balanced(h) * 100).toFixed(0)}%`]);
    }
    out.push(table(["rule", "threshold (chosen on tuning)", "tuning confusion", "bal.acc", "holdout confusion", "bal.acc"], rows));
  }
  return out.join("\n");
}
