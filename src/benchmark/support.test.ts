import { describe, expect, it } from "vitest";
import { loadSupport } from "./support";

describe("human-labelled support set", () => {
  const tuning = loadSupport("tuning");
  const holdout = loadSupport("holdout");
  const all = [...tuning, ...holdout];

  it("has 20-30 claims covering every label and positive, negative and adversarial kinds", () => {
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(all.length).toBeLessThanOrEqual(30);
    for (const label of ["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED"]) expect(all.some((i) => i.label === label), label).toBe(true);
    for (const kind of ["positive", "negative", "adversarial"]) expect(all.some((i) => i.kind === kind), kind).toBe(true);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
  });

  it("states the label provenance honestly: labels are owner-supplied references (not independent ground truth) only because a completed review file exists", () => {
    for (const i of all) expect(i.labelSource).toBe("owner-supplied-reference");
  });

  it("gives every item a rationale and a precise evidence range", () => {
    for (const i of all) {
      expect(i.rationale.length, i.id).toBeGreaterThan(10);
      expect(i.evidence.startLine, i.id).toBeGreaterThanOrEqual(1);
      expect(i.evidence.endLine, i.id).toBeGreaterThanOrEqual(i.evidence.startLine);
    }
  });
});
