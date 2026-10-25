import { describe, expect, it } from "vitest";
import { answerQuestion } from "./answer";
import { ExtractiveBaselineProvider } from "./provider";
import { FILES, ScriptedModel, buildFixture, deps } from "./test-helpers";

// Fix B (W-4, flag leadsOnRefusal). A policy that refuses everything that retrieved something forces the pre-model refusal.
const REFUSE_ALL = { insufficientBelow: 1.1, cautionBelow: 1.2 };
const Q = "where is loginUser implemented";
const withoutVolatile = (r: object): object => {
  const rest: Record<string, unknown> = { ...r };
  delete rest.stats;
  return rest;
};

describe("leads on a refusal before the model", () => {
  it("(a) flag OFF: no leads and no refusalReason key, same result as without the option", async () => {
    const { index, source } = await buildFixture(FILES);
    const plain = await answerQuestion(deps({ index, source, provider: new ScriptedModel("never"), policy: REFUSE_ALL }), Q);
    const off = await answerQuestion(deps({ index, source, provider: new ScriptedModel("never"), policy: REFUSE_ALL, leadsOnRefusal: false }), Q);
    expect(plain.status).toBe("insufficient_evidence");
    for (const r of [plain, off]) {
      expect(Object.keys(r)).not.toContain("leads");
      expect(Object.keys(r)).not.toContain("refusalReason");
    }
    expect(Object.keys(off).sort()).toEqual(Object.keys(plain).sort());
    expect(withoutVolatile(off)).toEqual(withoutVolatile(plain));
  });

  it("(b) flag ON: leads in rank order, at most 5 distinct files, no claims, no evidence, no model call", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) files[`src/m${i}.ts`] = `export function alphaBeta${i}() {\n  return "alpha beta ${i}";\n}\n`;
    const { index, source } = await buildFixture(files);
    const model = new ScriptedModel("never");
    const r = await answerQuestion(deps({ index, source, provider: model, policy: REFUSE_ALL, leadsOnRefusal: true }), "where is alpha beta");
    expect(r.status).toBe("insufficient_evidence");
    expect(r.policy.action).toBe("insufficient");
    expect(r.stats.modelCalled).toBe(false);
    expect(model.requests).toHaveLength(0);
    expect(r.refusalReason).toBe("pre-model-coverage");
    expect(r.claims).toEqual([]);
    expect(r.evidence).toEqual([]);
    const leads = r.leads!;
    expect(leads.length).toBe(5);
    expect(new Set(leads.map((l) => l.path)).size).toBe(5);
    for (let i = 1; i < leads.length; i++) expect(leads[i]!.rank).toBeGreaterThan(leads[i - 1]!.rank);
    expect(leads[0]!.rank).toBeGreaterThanOrEqual(1);
    expect(Object.keys(leads[0]!).sort()).toEqual(["endLine", "path", "rank", "startLine"]);
  });

  it("(c) flag ON leaves an answered result unchanged", async () => {
    const { index, source } = await buildFixture(FILES);
    const on = await answerQuestion(deps({ index, source, provider: new ExtractiveBaselineProvider(), leadsOnRefusal: true }), Q);
    const off = await answerQuestion(deps({ index, source, provider: new ExtractiveBaselineProvider() }), Q);
    expect(on.status).toBe("answered");
    expect(Object.keys(on)).not.toContain("leads");
    expect(Object.keys(on)).not.toContain("refusalReason");
    expect(Object.keys(on).sort()).toEqual(Object.keys(off).sort());
    expect(withoutVolatile(on)).toEqual(withoutVolatile(off));
  });

  it("(d) a model refusal carries no leads, flag ON", async () => {
    const { index, source } = await buildFixture(FILES);
    const model = new ScriptedModel(JSON.stringify({ status: "insufficient_evidence", missing: "x" }));
    const r = await answerQuestion(deps({ index, source, provider: model, policy: { insufficientBelow: 0, cautionBelow: 0.99 }, leadsOnRefusal: true }), "where is loginUser refund implemented");
    expect(r.status).toBe("insufficient_evidence");
    expect(r.stats.modelCalled).toBe(true);
    expect(Object.keys(r)).not.toContain("leads");
    expect(Object.keys(r)).not.toContain("refusalReason");
  });

  it("(e) the path is cut to 200 characters and loses control characters", async () => {
    const long = `src/${"a".repeat(5000)}.ts`;
    const dirty = "src/we\u0001ird\u007f\nname.ts";
    const body = 'export function alphaBeta() {\n  return "alpha beta";\n}\n';
    const { index, source } = await buildFixture({ [long]: body, [dirty]: body });
    const r = await answerQuestion(deps({ index, source, provider: new ScriptedModel("never"), policy: REFUSE_ALL, leadsOnRefusal: true }), "where is alpha beta");
    const paths = (r.leads ?? []).map((l) => l.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect(/[\u0000-\u001f\u007f]/.test(p)).toBe(false);
    }
    expect(paths).toContain("src/weirdname.ts");
    expect(paths.some((p) => p.length === 200)).toBe(true);
  });

  it("(g) empty retrieval: no leads key, refusalReason still set", async () => {
    const { index, source } = await buildFixture(FILES);
    const r = await answerQuestion(deps({ index, source, provider: new ScriptedModel("never"), leadsOnRefusal: true }), "zzzqqq xxyyzz");
    expect(r.status).toBe("insufficient_evidence");
    expect(r.stats.modelCalled).toBe(false);
    expect(Object.keys(r)).not.toContain("leads");
    expect(r.refusalReason).toBe("pre-model-coverage");
  });

  it("(g) one file only gives one lead", async () => {
    const { index, source } = await buildFixture({ "src/only.ts": 'export function alphaBeta() {\n  return "alpha beta";\n}\n' });
    const r = await answerQuestion(deps({ index, source, provider: new ScriptedModel("never"), policy: REFUSE_ALL, leadsOnRefusal: true }), "where is alpha beta");
    expect(r.leads).toHaveLength(1);
    expect(r.leads![0]).toMatchObject({ path: "src/only.ts", rank: 1 });
  });

  it("(g) several blocks of one file give one lead, with the best rank of that file", async () => {
    const big = Array.from({ length: 80 }, (_, i) => `export function alphaBeta${i}() {\n  const a = "alpha beta ${i}";\n  const b = a + "${"x".repeat(60)}";\n  return b;\n}\n`).join("\n");
    const { index, source } = await buildFixture({ "src/big.ts": big, "src/small.ts": 'export function alphaBeta() {\n  return "alpha beta";\n}\n' });
    const r = await answerQuestion(deps({ index, source, provider: new ScriptedModel("never"), policy: REFUSE_ALL, leadsOnRefusal: true }), "where is alpha beta");
    const paths = r.leads!.map((l) => l.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.sort()).toEqual(["src/big.ts", "src/small.ts"]);
  });
});
