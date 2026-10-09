import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeClaim, compareLabels, SUPPORT_LABELS, type Agreement, type SupportLabel } from "../answer/judge";
import type { ModelProvider } from "../answer/provider";
import { loadFixture } from "./fixtures";
import { assertFrozen, loadRepos, type Split } from "./dataset";
import { loadSourceText } from "./answer-eval";
import { excerptOf, loadHumanReviews, loadSupportQuestions, renderReviewMarkdown, shaOf, toReviewLabel, toSupportLabel, validateReviews, type ReviewExportItem } from "./support-review";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dataset/v2");

export interface SupportItem {
  id: string;
  repo: string;
  kind: "positive" | "negative" | "adversarial";
  claim: string;
  evidence: { path: string; startLine: number; endLine: number };
  label: SupportLabel;
  paraphrases: string[];
  rationale: string;
  /** Evidence comes from the synthetic adversarial fixture rather than a pinned repository */
  fixture?: boolean;
}

export interface ReviewedLabel {
  id: string;
  label: SupportLabel;
  reviewer: string;
  note?: string;
}

/**
 * The reference labels were first drafted by the assistant that wrote this code (an LLM), NOT by a person. They only become an owner-supplied reference label (NOT independent ground truth, if they equal the draft)
 * for an item once the owner records them in support.human-review.json.
 */
export interface LabelledItem extends SupportItem {
  labelSource: "assistant-draft" | "owner-supplied-reference";
  /** The draft label, when a human review changed it */
  draftLabel?: SupportLabel;
}

export function loadSupport(split: Split): LabelledItem[] {
  const items = JSON.parse(readFileSync(path.join(DIR, `support.${split}.json`), "utf8")) as SupportItem[];
  const reviewFile = path.join(DIR, "support.review.json");
  // support.review.json is the earlier, still-honoured format; support.human-review.json takes precedence.
  const reviews = new Map((existsSync(reviewFile) ? (JSON.parse(readFileSync(reviewFile, "utf8")) as ReviewedLabel[]) : []).map((r) => [r.id, r]));
  for (const h of loadHumanReviews()) if (h.reviewed && h.final_label) reviews.set(h.id, { id: h.id, label: toSupportLabel(h.final_label), reviewer: "owner-supplied", note: h.reviewer_note });
  return items.map((i) => {
    const r = reviews.get(i.id);
    return r ? { ...i, label: r.label, labelSource: "owner-supplied-reference", draftLabel: i.label } : { ...i, labelSource: "assistant-draft" };
  });
}

/** Source text of the evidence span, from the pinned commit (cached tarball) or the adversarial fixture. */
export async function evidenceText(item: SupportItem): Promise<string> {
  const lines = item.fixture ? (loadFixture().files[item.evidence.path] ?? null) : await loadSourceText(item.repo, item.evidence.path);
  if (lines === null) throw new Error(`${item.id}: no such file ${item.evidence.path}`);
  const all = lines.split("\n");
  if (item.evidence.startLine < 1 || item.evidence.endLine > all.length) throw new Error(`${item.id}: range outside file (${all.length} lines)`);
  return all.slice(item.evidence.startLine - 1, item.evidence.endLine).join("\n");
}

export async function validateSupportSet(): Promise<string[]> {
  const problems: string[] = [];
  const known = new Set([...loadRepos().map((r) => r.repo), "fixture/adversarial"]);
  const seen = new Set<string>();
  for (const split of ["tuning", "holdout"] as const) {
    for (const i of loadSupport(split)) {
      if (seen.has(i.id)) problems.push(`${i.id}: duplicate id`);
      seen.add(i.id);
      if (!known.has(i.repo)) problems.push(`${i.id}: unknown repo ${i.repo}`);
      if (!(SUPPORT_LABELS as readonly string[]).includes(i.label)) problems.push(`${i.id}: bad label`);
      if (i.repo !== "fixture/adversarial" && loadRepos().find((r) => r.repo === i.repo)?.split !== split) problems.push(`${i.id}: repo is not in the ${split} split`);
      try {
        await evidenceText(i);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return problems;
}

export interface JudgeEvalResult {
  provider: string;
  split: Split;
  agreement: Agreement;
  providerFailures: number;
  items: { id: string; human: SupportLabel; judge: SupportLabel | null; reason: string }[];
}

/** Runs a judge over a labelled split and compares it with the reference labels. The judge is evaluated, never trusted. */
export async function evaluateJudge(provider: ModelProvider, split: Split): Promise<JudgeEvalResult> {
  if (split === "holdout") assertFrozen();
  const items: JudgeEvalResult["items"] = [];
  let providerFailures = 0;
  for (const i of loadSupport(split)) {
    const text = await evidenceText(i);
    const v = await judgeClaim(provider, { claim: i.claim, ...i.evidence, text });
    if (!v.ok && "providerError" in v) providerFailures += 1;
    items.push({ id: i.id, human: i.label, judge: v.ok ? v.label : null, reason: v.reason });
  }
  return { provider: provider.name, split, agreement: compareLabels(items), providerFailures, items };
}

export function reviewStatus(): { reviewed: number; total: number; problems: string[] } {
  const ids = [...loadSupport("tuning"), ...loadSupport("holdout")].map((i) => i.id);
  const reviews = loadHumanReviews();
  return { reviewed: reviews.filter((r) => r.reviewed).length, total: ids.length, problems: validateReviews(reviews, ids) };
}

/** Builds the human-review document: current drafts, evidence excerpts and rationales, unchanged. */
export async function exportReview(): Promise<string> {
  const questions = loadSupportQuestions();
  const items: ReviewExportItem[] = [];
  for (const split of ["tuning", "holdout"] as const) {
    for (const i of loadSupport(split)) {
      const text = await evidenceText(i);
      items.push({
        id: i.id,
        split,
        repo: i.repo,
        sha: shaOf(i.repo),
        question: questions[i.id] ?? "(no question recorded)",
        claim: i.claim,
        label: toReviewLabel(i.draftLabel ?? i.label),
        path: i.evidence.path,
        startLine: i.evidence.startLine,
        endLine: i.evidence.endLine,
        excerpt: excerptOf(text, i.evidence.startLine),
        rationale: i.rationale,
      });
    }
  }
  const s = reviewStatus();
  return renderReviewMarkdown(items, { reviewed: s.reviewed, total: s.total });
}
