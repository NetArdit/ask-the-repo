import { describe, expect, it } from "vitest";
import { assertFrozen, loadQuestions, loadRepos } from "./dataset";
import { loadFixture } from "./fixtures";

describe("frozen evaluation dataset v2", () => {
  const repos = loadRepos();
  const tuning = loadQuestions("tuning");
  const holdout = loadQuestions("holdout");

  it("has at least 15 pinned repositories with distinct splits", () => {
    expect(repos.length).toBeGreaterThanOrEqual(15);
    for (const r of repos) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(repos.map((r) => r.repo)).size).toBe(repos.length);
    const tuningRepos = new Set(repos.filter((r) => r.split === "tuning").map((r) => r.repo));
    const holdoutRepos = new Set(repos.filter((r) => r.split === "holdout").map((r) => r.repo));
    for (const r of holdoutRepos) expect(tuningRepos.has(r)).toBe(false);
    expect(tuningRepos.size).toBeGreaterThanOrEqual(5);
    expect(holdoutRepos.size).toBeGreaterThanOrEqual(5);
  });

  it("keeps every question inside its own split, with unique ids", () => {
    const split = new Map(repos.map((r) => [r.repo, r.split]));
    for (const q of tuning) expect(split.get(q.repo)).toBe("tuning");
    for (const q of holdout) expect(split.get(q.repo)).toBe("holdout");
    const ids = [...tuning, ...holdout].map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has at least 10 questions per repository, each with a negative case", () => {
    for (const r of repos) {
      const qs = [...tuning, ...holdout].filter((q) => q.repo === r.repo);
      expect(qs.length, r.repo).toBeGreaterThanOrEqual(10);
      expect(qs.some((q) => q.expected.length === 0), r.repo).toBe(true);
    }
  });

  it("covers the required question categories", () => {
    const categories = new Set([...tuning, ...holdout].map((q) => q.category));
    for (const c of ["exact-location", "symbol", "imports", "endpoint", "entry-point", "config", "conceptual", "cross-file", "negative"]) {
      expect(categories.has(c as never), c).toBe(true);
    }
    expect(loadFixture().questions.some((q) => q.category === "adversarial")).toBe(true);
  });

  it("states expected evidence for every positive question and absent terms for every negative one", () => {
    for (const q of [...tuning, ...holdout]) {
      // An empty list marks a hard negative: the vocabulary exists in the repository, the implementation does not.
      if (q.category === "negative") expect(q.absentTerms, q.id).toBeDefined();
      else expect(q.expected.length, q.id).toBeGreaterThan(0);
    }
  });

  it("has not changed since the holdout was frozen", () => {
    expect(() => assertFrozen()).not.toThrow();
  });
});
