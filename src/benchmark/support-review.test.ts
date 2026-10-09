import { describe, expect, it } from "vitest";
import { excerptOf, loadHumanReviews, loadSupportQuestions, renderReviewMarkdown, toReviewLabel, toSupportLabel, validateReviews, type HumanReview } from "./support-review";
import { loadSupport, reviewStatus } from "./support";

const IDS = ["A", "B"];
const item = (over: Partial<HumanReview>): HumanReview => ({ id: "A", reviewed: false, final_label: null, reviewer_note: "", ...over });

describe("review file validation", () => {
  it("accepts unreviewed and fully reviewed entries", () => {
    expect(validateReviews([item({}), item({ id: "B", reviewed: true, final_label: "PARTIAL", reviewer_note: "ok" })], IDS)).toEqual([]);
  });

  it.each([
    ["a reviewed item without a label", [item({ reviewed: true }), item({ id: "B" })], "need a final_label"],
    ["an invalid label", [item({ reviewed: true, final_label: "MAYBE" as never }), item({ id: "B" })], "need a final_label"],
    ["PARTIALLY_SUPPORTED (the reviewer-facing name is PARTIAL)", [item({ reviewed: true, final_label: "PARTIALLY_SUPPORTED" as never }), item({ id: "B" })], "need a final_label"],
    ["a label on an unreviewed item", [item({ final_label: "SUPPORTED" }), item({ id: "B" })], "unreviewed item must have final_label null"],
    ["a missing claim", [item({})], "B: missing"],
    ["an unknown id", [item({}), item({ id: "B" }), item({ id: "Z" })], "unknown claim id"],
    ["a duplicate", [item({}), item({}), item({ id: "B" })], "duplicate"],
  ] as const)("rejects %s", (_n, reviews, fragment) => {
    expect(validateReviews([...reviews], IDS).join(" ")).toContain(fragment);
  });
});

describe("shipped review file", () => {
  it("covers all 28 claims, valid, and all marked reviewed with the expected distribution", () => {
    const s = reviewStatus();
    expect(s.total).toBe(28);
    expect(s.problems).toEqual([]);
    expect(s.reviewed).toBe(28);
    const dist: Record<string, number> = {};
    for (const r of loadHumanReviews()) {
      expect(r.reviewed).toBe(true);
      dist[r.final_label as string] = (dist[r.final_label as string] ?? 0) + 1;
    }
    expect(dist).toEqual({ SUPPORTED: 14, PARTIAL: 3, UNSUPPORTED: 7, CONTRADICTED: 4 });
  });

  it("marks every claim as an owner-supplied reference label (provenance follows the review file), and has a question for each", () => {
    const items = [...loadSupport("tuning"), ...loadSupport("holdout")];
    expect(items.every((i) => i.labelSource === "owner-supplied-reference")).toBe(true);
    const q = loadSupportQuestions();
    for (const i of items) expect(q[i.id], i.id).toBeTruthy();
  });
});

describe("label naming and rendering", () => {
  it("maps PARTIAL to PARTIALLY_SUPPORTED and back", () => {
    expect(toSupportLabel("PARTIAL")).toBe("PARTIALLY_SUPPORTED");
    expect(toReviewLabel("PARTIALLY_SUPPORTED")).toBe("PARTIAL");
    expect(toSupportLabel("SUPPORTED")).toBe("SUPPORTED");
  });

  it("truncates long excerpts and says how much was left out", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const e = excerptOf(text, 100);
    expect(e.split("\n")[0]).toBe("100| line 0");
    expect(e).toContain("(10 more lines in the range)");
  });

  it("renders the required fields and says the labels are drafts", () => {
    const md = renderReviewMarkdown([{ id: "S01", split: "tuning", repo: "a/b", sha: "c".repeat(40), question: "Q?", claim: "C.", label: "PARTIAL", path: "x.ts", startLine: 1, endLine: 2, excerpt: "1| x", rationale: "R" }], { reviewed: 0, total: 1 });
    for (const needle of ["S01 (tuning): PARTIAL", "a/b @ " + "c".repeat(40), "Question: Q?", "Claim: C.", "x.ts", "lines 1-2", "Rationale (draft): R", "assistant drafts"]) expect(md).toContain(needle);
  });
});
