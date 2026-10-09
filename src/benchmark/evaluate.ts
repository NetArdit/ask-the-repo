import type { Evidence } from "../retrieve/search";
import type { BenchQuestion, ExpectedEvidence } from "./dataset";

export const KS = [1, 3, 5, 10] as const;

export function overlaps(e: Pick<Evidence, "path" | "startLine" | "endLine">, x: ExpectedEvidence): boolean {
  if (e.path !== x.path) return false;
  if (!x.lines) return true;
  return e.startLine <= x.lines[1] && e.endLine >= x.lines[0];
}

export interface QuestionScore {
  id: string;
  category: string;
  negative: boolean;
  /** 1-based rank of the first evidence that matches any expected item, or null. */
  firstHitRank: number | null;
  hitAtK: Record<number, boolean>;
  /** Share of expected items matched by the top-k evidence. */
  itemRecallAtK: Record<number, number>;
  /** Share of top-5 evidence that matches an expected item. */
  precisionAt5: number;
}

export function scoreQuestion(q: BenchQuestion, evidence: Evidence[]): QuestionScore {
  const matches = (e: Evidence): boolean => q.expected.some((x) => overlaps(e, x));
  const firstIdx = evidence.findIndex(matches);
  const hitAtK: Record<number, boolean> = {};
  const itemRecallAtK: Record<number, number> = {};
  for (const k of KS) {
    const top = evidence.slice(0, k);
    hitAtK[k] = top.some(matches);
    itemRecallAtK[k] = q.expected.length === 0 ? 0 : q.expected.filter((x) => top.some((e) => overlaps(e, x))).length / q.expected.length;
  }
  const top5 = evidence.slice(0, 5);
  return {
    id: q.id,
    category: q.category,
    negative: q.expected.length === 0,
    firstHitRank: firstIdx === -1 ? null : firstIdx + 1,
    hitAtK,
    itemRecallAtK,
    precisionAt5: top5.length === 0 ? 0 : top5.filter(matches).length / top5.length,
  };
}

export interface Aggregate {
  questions: number;
  hitAtK: Record<number, number>;
  itemRecallAtK: Record<number, number>;
  precisionAt5: number;
  mrr: number;
}

export function aggregate(scores: QuestionScore[]): Aggregate {
  const positives = scores.filter((s) => !s.negative);
  const n = positives.length || 1;
  const hitAtK: Record<number, number> = {};
  const itemRecallAtK: Record<number, number> = {};
  for (const k of KS) {
    hitAtK[k] = positives.filter((s) => s.hitAtK[k]).length / n;
    itemRecallAtK[k] = positives.reduce((a, s) => a + (s.itemRecallAtK[k] ?? 0), 0) / n;
  }
  return {
    questions: positives.length,
    hitAtK,
    itemRecallAtK,
    precisionAt5: positives.reduce((a, s) => a + s.precisionAt5, 0) / n,
    mrr: positives.reduce((a, s) => a + (s.firstHitRank ? 1 / s.firstHitRank : 0), 0) / n,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
