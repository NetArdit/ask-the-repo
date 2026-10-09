import { describe, expect, it } from "vitest";
import { answerQuestion } from "./answer";
import { definitionCandidates } from "./definitions";
import { ScriptedModel, buildFixture, deps } from "./test-helpers";

const filler = (name: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`).join("\n");

const FILES: Record<string, string> = {
  "src/checkout/pay.ts": [
    'import { computeTotal } from "../pricing/total";',
    'import { audit } from "../log/audit";',
    "",
    "export async function payOrder(orderId: string, items: number[]) {",
    "  if (items.length === 0) return null;",
    "  const total = computeTotal(items);",
    "  audit(orderId);",
    "  return { orderId, total };",
    "}",
    "",
  ].join("\n"),
  "src/pricing/total.ts": ["export function computeTotal(items: number[]): number {", "  let sum = 0;", "  for (const cents of items) sum += cents;", "  return Math.round(sum * 1.2);", "}", ""].join("\n"),
  "src/log/audit.ts": ["export function audit(id: string): void {", "  const line = `order ${id}`;", "  void line;", "}", ""].join("\n"),
  // Two unrelated files that both define `format`: a call to it from elsewhere cannot be resolved, so it is not followed.
  "src/a/format.ts": ["export function format(x: number): string {", "  const s = String(x);", "  return s;", "}", ""].join("\n"),
  "src/b/format.ts": ["export function format(x: string): string {", "  const s = x.trim();", "  return s;", "}", ""].join("\n"),
  "src/report/print.ts": ["export function printAll(xs: number[]) {", "  return xs.map((x) => format(x));", "}", "declare function format(x: number): string;", ""].join("\n"),
};

const ASK = "what does compute total do and what is the audit for";
const itemOf = (path: string, text: string, startLine = 1) => ({ path, startLine, endLine: startLine + text.split("\n").length - 1, text });

describe("definitionCandidates", () => {
  it("offers the definitions of what the shown lines call, most-called first, and only when the index resolves the name to one definition", async () => {
    const { index } = await buildFixture(FILES);
    const pay = itemOf("src/checkout/pay.ts", FILES["src/checkout/pay.ts"]!);
    const found = definitionCandidates(index, [pay], ASK, { maxBlocks: 5 });
    expect(found.map((c) => [c.path, c.symbol])).toEqual([
      ["src/pricing/total.ts", "computeTotal"],
      ["src/log/audit.ts", "audit"],
    ]);
    // Each is a whole chunk of the index, which is what lets the pipeline verify it against the commit like any other block.
    for (const c of found) {
      const chunk = index.artifact.chunks[c.chunkId]!;
      expect([index.pathOf(chunk[0]), chunk[1], chunk[2]]).toEqual([c.path, c.startLine, c.endLine]);
    }
    expect(definitionCandidates(index, [pay], ASK, { maxBlocks: 1 })).toHaveLength(1);
    expect(definitionCandidates(index, [pay], ASK, { maxBlocks: 0 })).toEqual([]);
  });

  it("does not follow keywords, names it cannot resolve, ambiguous names, or definitions already on show", async () => {
    const { index } = await buildFixture(FILES);
    // `if (`, `return (`, an unknown function and a method of a built-in: nothing to add.
    const noise = itemOf("src/checkout/pay.ts", "if (x) { return (y); }\nunknownThing(1);\nitems.map((i) => i);\nawait (z);");
    expect(definitionCandidates(index, [noise], "unknown thing items map", { maxBlocks: 5 })).toEqual([]);
    // `format` is defined in two files and print.ts imports neither: no guess is made.
    const print = itemOf("src/report/print.ts", FILES["src/report/print.ts"]!);
    expect(definitionCandidates(index, [print], "how are numbers put into a format", { maxBlocks: 5 })).toEqual([]);
    // The definition is already among the shown blocks.
    const pay = itemOf("src/checkout/pay.ts", FILES["src/checkout/pay.ts"]!);
    const total = itemOf("src/pricing/total.ts", FILES["src/pricing/total.ts"]!);
    expect(definitionCandidates(index, [pay, total], ASK, { maxBlocks: 5 }).map((c) => c.symbol)).toEqual(["audit"]);
  });

  it("finds a definition elsewhere in the same file, in the chunk that holds its first lines", async () => {
    const big = [filler("a", 120), "export function farAway(n: number): number {", "  const doubled = n * 2;", "  return doubled + 1;", "}", filler("b", 120), "export function caller() {", "  return farAway(3);", "}", ""].join("\n");
    const { index } = await buildFixture({ "src/big.ts": big });
    const lines = big.split("\n");
    const callLine = lines.indexOf("  return farAway(3);") + 1;
    const defLine = lines.indexOf("export function farAway(n: number): number {") + 1;
    const callChunk = index.artifact.chunks[index.chunkAtLine(0, callLine)!]!;
    const defChunk = index.chunkAtLine(0, defLine)!;
    expect(index.chunkAtLine(0, callLine)).not.toBe(defChunk); // otherwise this test would prove nothing
    const shown = itemOf("src/big.ts", lines.slice(callChunk[1] - 1, callChunk[2]).join("\n"), callChunk[1]);
    const found = definitionCandidates(index, [shown], "what does far away return", { maxBlocks: 2 });
    expect(found.map((c) => [c.symbol, c.chunkId])).toEqual([["farAway", defChunk]]);
  });
});

describe("answerQuestion with definition evidence", () => {
  const QUESTION = "what total does payOrder compute, and what does it audit";
  const reply = '{"status":"insufficient_evidence","missing":"x"}';

  it("is off by default, and when on adds verified definition blocks after the retrieved ones without displacing any", async () => {
    const { index, source } = await buildFixture(FILES);
    const base = deps({ index, source, provider: new ScriptedModel(reply), maxEvidence: 1 });
    const off = await answerQuestion(base, QUESTION);
    expect(off.evidence.map((e) => e.path)).toEqual(["src/checkout/pay.ts"]);

    const on = await answerQuestion({ ...base, definitionEvidence: { maxBlocks: 2 } }, QUESTION);
    expect(on.evidence.map((e) => [e.id, e.path])).toEqual([
      ["E1", "src/checkout/pay.ts"],
      ["E2", "src/pricing/total.ts"],
      ["E3", "src/log/audit.ts"],
    ]);
    expect(on.evidence[0]).toEqual(off.evidence[0]);
    expect(on.stats.evidenceCount).toBe(3);
    expect(on.stats.evidenceChars).toBeGreaterThan(off.stats.evidenceChars);
    expect(on.rejectedEvidence).toEqual([]);
    for (const e of on.evidence) expect(e.url).toContain(`/blob/${"d".repeat(40)}/`);
  });

  it("puts the added blocks in the prompt under their own ids, so the model can cite them and the validator accepts the citation", async () => {
    const { index, source } = await buildFixture(FILES);
    const answered = JSON.stringify({ status: "answered", claims: [{ text: "computeTotal adds the items and applies a factor of 1.2.", evidence: [{ citation: "E2", quote: "return Math.round(sum * 1.2);" }] }] });
    const out = await answerQuestion({ ...deps({ index, source, provider: new ScriptedModel(answered), maxEvidence: 1 }), definitionEvidence: { maxBlocks: 2 } }, QUESTION);
    expect(out.status).toBe("answered");
    expect(out.claims[0]!.citations[0]).toMatchObject({ id: "E2", verdict: { valid: true }, quoteVerbatim: true });
    // The same reply without the definition block cites an id that was never offered, and is withheld.
    const without = await answerQuestion(deps({ index, source, provider: new ScriptedModel(answered), maxEvidence: 1 }), QUESTION);
    expect(without.status).toBe("rejected");
  });

  it("follows only functions whose name shares a word with the question", async () => {
    const { index, source } = await buildFixture(FILES);
    const out = await answerQuestion({ ...deps({ index, source, provider: new ScriptedModel(reply), maxEvidence: 1 }), definitionEvidence: { maxBlocks: 2 } }, "where is payOrder implemented");
    expect(out.evidence.map((e) => e.path)).toEqual(["src/checkout/pay.ts"]);
    const pay = itemOf("src/checkout/pay.ts", FILES["src/checkout/pay.ts"]!);
    // "total" names computeTotal and not audit; a question made only of weak words names nothing.
    expect(definitionCandidates(index, [pay], "how is the total worked out", { maxBlocks: 5 }).map((c) => c.symbol)).toEqual(["computeTotal"]);
    expect(definitionCandidates(index, [pay], "how does this get all that", { maxBlocks: 5 })).toEqual([]);
  });

  it("adds nothing once the character budget is used up", async () => {
    const { index, source } = await buildFixture(FILES);
    const tight = FILES["src/checkout/pay.ts"]!.length + 20;
    const out = await answerQuestion({ ...deps({ index, source, provider: new ScriptedModel(reply), maxEvidence: 1, evidenceBudgetChars: tight }), definitionEvidence: { maxBlocks: 2 } }, QUESTION);
    expect(out.evidence.map((e) => e.path)).toEqual(["src/checkout/pay.ts"]);
    expect(out.stats.evidenceChars).toBeLessThanOrEqual(tight);
  });
});
