import { describe, expect, it } from "vitest";
import { ExtractiveBaselineProvider, type ModelRequest } from "./provider";
import { buildPrompt } from "./prompt";
import { decideSufficiency } from "./policy";

const REQ: ModelRequest = { system: "sys", user: "usr", maxTokens: 50, nonce: "n" };

describe("ExtractiveBaselineProvider", () => {
  const repo = { owner: "a", repo: "b", sha: "e".repeat(40) };
  const ev = { id: "E1", key: "k", repo, path: "x.ts", startLine: 1, endLine: 2, text: "// header comment\nexport const value = 42;", chunkHash: "h", fileLineCount: 2, score: 1, injectionSuspect: false };

  it("cites the evidence it is given with a verbatim quote, and says it is not a model", async () => {
    const p = buildPrompt("q", repo, [ev]);
    const provider = new ExtractiveBaselineProvider();
    const out = JSON.parse(await provider.complete({ ...REQ, user: p.user, nonce: p.nonce })) as { claims: { evidence: { citation: string; quote: string }[] }[] };
    expect(out.claims[0]).toMatchObject({ evidence: [{ citation: "E1", quote: "export const value = 42;" }] });
    expect(provider.name).toBe("extractive-baseline");
  });

  it("declines when there is no evidence", async () => {
    const p = buildPrompt("q", repo, []);
    expect(JSON.parse(await new ExtractiveBaselineProvider().complete({ ...REQ, user: p.user, nonce: p.nonce }))).toMatchObject({ status: "insufficient_evidence" });
  });
});

describe("decideSufficiency", () => {
  const features = (idfCoverage: number) => ({ topScore: 1, margin: 0.1, idfCoverage, top1Coverage: idfCoverage, exactSymbolInTop3: false, pathHitTop1: false, queryTermCount: 3, identifierCount: 0 });
  const cfg = { insufficientBelow: 0.2, cautionBelow: 0.5 };

  it.each([
    [0.1, "insufficient"],
    [0.3, "caution"],
    [0.8, "answer"],
  ] as const)("coverage %f -> %s", (coverage, action) => {
    expect(decideSufficiency(features(coverage), 5, cfg).action).toBe(action);
  });

  it("refuses when nothing was retrieved", () => {
    expect(decideSufficiency(features(1), 0, cfg).action).toBe("insufficient");
  });
});
