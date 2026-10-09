import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupportLabel } from "../answer/judge";
import { loadRepos, type Split } from "./dataset";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dataset/v2");

/** The four labels a reviewer may write. PARTIAL is the reviewer-facing name of PARTIALLY_SUPPORTED. */
export const REVIEW_LABELS = ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "CONTRADICTED"] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

export function toSupportLabel(l: ReviewLabel): SupportLabel {
  return l === "PARTIAL" ? "PARTIALLY_SUPPORTED" : l;
}

export function toReviewLabel(l: SupportLabel): ReviewLabel {
  return l === "PARTIALLY_SUPPORTED" ? "PARTIAL" : l;
}

/** One entry per claim. An item is reviewed only when `reviewed` is true; nothing is inferred for the rest. */
export interface HumanReview {
  id: string;
  reviewed: boolean;
  final_label: ReviewLabel | null;
  reviewer_note: string;
}

export function loadHumanReviews(): HumanReview[] {
  return JSON.parse(readFileSync(path.join(DIR, "support.human-review.json"), "utf8")) as HumanReview[];
}

export function loadSupportQuestions(): Record<string, string> {
  return JSON.parse(readFileSync(path.join(DIR, "support.questions.json"), "utf8")) as Record<string, string>;
}

export function validateReviews(reviews: HumanReview[], knownIds: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of reviews) {
    if (seen.has(r.id)) problems.push(`${r.id}: duplicate entry`);
    seen.add(r.id);
    if (!knownIds.includes(r.id)) problems.push(`${r.id}: unknown claim id`);
    if (typeof r.reviewed !== "boolean") problems.push(`${r.id}: reviewed must be true or false`);
    if (r.reviewed) {
      if (r.final_label === null || !(REVIEW_LABELS as readonly string[]).includes(r.final_label)) problems.push(`${r.id}: reviewed items need a final_label of ${REVIEW_LABELS.join(", ")}`);
      if (typeof r.reviewer_note !== "string") problems.push(`${r.id}: reviewer_note must be a string`);
    } else if (r.final_label !== null) problems.push(`${r.id}: an unreviewed item must have final_label null`);
  }
  for (const id of knownIds) if (!seen.has(id)) problems.push(`${id}: missing from the review file`);
  return problems;
}

export interface ReviewExportItem {
  id: string;
  split: Split;
  repo: string;
  sha: string;
  question: string;
  claim: string;
  label: ReviewLabel;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  rationale: string;
}

export function shaOf(repo: string): string {
  return loadRepos().find((r) => r.repo === repo)?.sha ?? "n/a (synthetic fixture, no commit)";
}

const EXCERPT_LINES = 40;

export function excerptOf(text: string, startLine: number): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, EXCERPT_LINES).map((l, i) => `${startLine + i}| ${l.length > 140 ? `${l.slice(0, 137)}...` : l}`);
  return lines.length > EXCERPT_LINES ? `${shown.join("\n")}\n... (${lines.length - EXCERPT_LINES} more lines in the range)` : shown.join("\n");
}

export function renderReviewMarkdown(items: ReviewExportItem[], status: { reviewed: number; total: number }): string {
  const out: string[] = [
    "# Support-label review (28 claims)",
    "",
    "Labels below are **assistant drafts**, not human labels. Nothing becomes reference until you record a review.",
    "",
    "How to review: for each item, read the claim and the evidence range, then set that item in `src/benchmark/dataset/v2/support.human-review.json` to",
    '`{"id": "...", "reviewed": true, "final_label": "SUPPORTED|PARTIAL|UNSUPPORTED|CONTRADICTED", "reviewer_note": "..."}`.',
    "Leave `reviewed: false` and `final_label: null` for items you have not reviewed. Then run `exp-cli support-review-status`.",
    "",
    "Labels: SUPPORTED = evidence shows everything the claim says. PARTIAL = shows part. UNSUPPORTED = does not show it (and not the opposite). CONTRADICTED = shows the opposite.",
    "",
    `Review status: ${status.reviewed} of ${status.total} reviewed.`,
    "",
  ];
  for (const i of items) {
    out.push(
      `## ${i.id} (${i.split}): ${i.label}`,
      "",
      `- Repository: ${i.repo} @ ${i.sha}`,
      `- Question: ${i.question}`,
      `- Claim: ${i.claim}`,
      `- Current label: **${i.label}**`,
      `- Evidence: \`${i.path}\` lines ${i.startLine}-${i.endLine}`,
      `- Rationale (draft): ${i.rationale}`,
      "",
      "```",
      i.excerpt,
      "```",
      "",
    );
  }
  return out.join("\n");
}
