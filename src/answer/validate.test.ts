import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "./types";
import { DEFAULT_EVIDENCE_CONTRACT, EVIDENCE_CONTRACT, EvidenceRegistry, MAX_QUOTE_CHARS, MAX_RAW_QUOTE_CHARS, parseModelOutput, quoteIsVerbatim, trimQuote, validateAnswer } from "./validate";

const REPO = { owner: "acme", repo: "shop", sha: "a".repeat(40) };

function item(id: string, path: string, startLine: number, endLine: number, text: string, fileLineCount = 100): EvidenceItem {
  return { id, key: `acme/shop@${REPO.sha}:${path}#L${startLine}-L${endLine}`, repo: REPO, path, startLine, endLine, text, chunkHash: "x".repeat(12), fileLineCount, score: 1, injectionSuspect: false };
}

const E1 = item("E1", "src/a.ts", 10, 20, "export function alpha() {\n  return 1;\n}");
const E2 = item("E2", "src/b.ts", 1, 5, "const beta = 2;");
const registry = () => new EvidenceRegistry([E1, E2], REPO);

describe("citation checks", () => {
  it("accepts a bare evidence id and a fully consistent locator", () => {
    expect(registry().check({ id: "E1" })).toEqual({ valid: true });
    expect(registry().check({ id: "E1", owner: "acme", repo: "shop", sha: REPO.sha, path: "src/a.ts", startLine: 12, endLine: 15 })).toEqual({ valid: true });
  });

  it.each([
    ["unknown evidence id", { id: "E9" }, "unknown-evidence-id"],
    ["fabricated id format", { id: "../../etc/passwd" }, "unknown-evidence-id"],
    ["wrong path", { id: "E1", path: "src/other.ts" }, "wrong-path"],
    ["wrong sha", { id: "E1", sha: "b".repeat(40) }, "wrong-sha"],
    ["another repository's owner", { id: "E1", owner: "evil" }, "wrong-repository"],
    ["another repository's name", { id: "E1", repo: "other" }, "wrong-repository"],
    ["negative line", { id: "E1", startLine: -3, endLine: 12 }, "invalid-line-number"],
    ["zero line", { id: "E1", startLine: 0, endLine: 12 }, "invalid-line-number"],
    ["fractional line", { id: "E1", startLine: 10.5, endLine: 12 }, "invalid-line-number"],
    ["NaN line", { id: "E1", startLine: Number.NaN, endLine: 12 }, "invalid-line-number"],
    ["reversed range", { id: "E1", startLine: 18, endLine: 12 }, "reversed-range"],
    ["line beyond the file", { id: "E1", startLine: 10, endLine: 500 }, "range-beyond-file"],
    ["range outside the supplied evidence", { id: "E1", startLine: 1, endLine: 5 }, "outside-evidence-range"],
    ["range extending past the evidence", { id: "E1", startLine: 15, endLine: 40 }, "outside-evidence-range"],
  ] as const)("rejects %s", (_name, locator, reason) => {
    expect(registry().check(locator)).toEqual({ valid: false, reason });
  });

  it("rejects evidence that does not belong to the requested repository", () => {
    const foreign = { ...E1, repo: { ...REPO, owner: "evil" } };
    expect(new EvidenceRegistry([foreign], REPO).check({ id: "E1" })).toEqual({ valid: false, reason: "wrong-repository" });
  });

  it("rejects evidence from a different commit", () => {
    const stale = { ...E1, repo: { ...REPO, sha: "c".repeat(40) } };
    expect(new EvidenceRegistry([stale], REPO).check({ id: "E1" })).toEqual({ valid: false, reason: "wrong-sha" });
  });
});

const entry = (citation: string, quote: string) => ({ citation, quote });

describe("parseModelOutput", () => {
  const good = JSON.stringify({ status: "answered", claims: [{ text: "alpha returns 1", evidence: [entry("E1", "return 1;")] }] });

  it("accepts plain JSON, fenced JSON and JSON wrapped in a sentence", () => {
    expect(parseModelOutput(good).ok).toBe(true);
    expect(parseModelOutput(`\`\`\`json\n${good}\n\`\`\``).ok).toBe(true);
    expect(parseModelOutput(`Here you go: ${good} Hope that helps.`).ok).toBe(true);
  });

  it("reads each evidence entry as one id bound to its own quote", () => {
    const raw = JSON.stringify({ status: "answered", claims: [{ text: "two places", evidence: [entry("E1", "return 1;"), entry("E2", "const beta = 2;")] }] });
    expect(parseModelOutput(raw)).toEqual({ ok: true, output: { status: "answered", claims: [{ text: "two places", evidence: [entry("E1", "return 1;"), entry("E2", "const beta = 2;")] }] } });
  });

  it("accepts an insufficient-evidence reply", () => {
    expect(parseModelOutput('{"status":"insufficient_evidence","missing":"no auth code"}')).toEqual({ ok: true, output: { status: "insufficient_evidence", missing: "no auth code" } });
  });

  it.each([
    "I think the answer is in src/a.ts",
    "",
    "[]",
    "null",
    '{"status":"maybe"}',
    '{"status":"answered"}',
    '{"status":"answered","claims":[]}',
    '{"status":"answered","claims":"E1"}',
    '{"status":"answered","claims":[{"evidence":[{"citation":"E1","quote":"return 1;"}]}]}',
    '{"status":"insufficient_evidence","missing":7}',
    '{"status":"answered","claims":[{"text":"x","evidence":[{"citation":"E1","quote":"return 1;"}]',
  ])("rejects malformed output %j", (raw) => {
    expect(parseModelOutput(raw).ok).toBe(false);
  });

  it.each([
    ["the older shape: a list of ids and one loose quote", { text: "x", citations: ["E1", "E2"], quote: "return 1;" }],
    ["evidence that is not a list", { text: "x", evidence: "E1" }],
    ["evidence missing altogether", { text: "x" }],
    ["an entry that is a bare id", { text: "x", evidence: ["E1"] }],
    ["an entry with no quote", { text: "x", evidence: [{ citation: "E1" }] }],
    ["an entry with an empty quote", { text: "x", evidence: [{ citation: "E1", quote: "   " }] }],
    ["an entry with a non-string quote", { text: "x", evidence: [{ citation: "E1", quote: 5 }] }],
    ["an entry with no id", { text: "x", evidence: [{ quote: "return 1;" }] }],
    ["an entry naming several ids for one quote", { text: "x", evidence: [{ citation: ["E1", "E2"], quote: "return 1;" }] }],
    ["an entry with a quote too long to be a quote", { text: "x", evidence: [{ citation: "E1", quote: "y".repeat(5000) }] }],
    ["one good entry and one malformed", { text: "x", evidence: [{ citation: "E1", quote: "return 1;" }, { citation: "E2" }] }],
    ["too many entries", { text: "x", evidence: Array.from({ length: 20 }, () => ({ citation: "E1", quote: "return 1;" })) }],
  ])("fails closed on %s", (_name, claim) => {
    const r = parseModelOutput(JSON.stringify({ status: "answered", claims: [claim] }));
    expect(r.ok).toBe(false);
  });

  it("rejects too many claims and over-long text", () => {
    const many = { status: "answered", claims: Array.from({ length: 20 }, () => ({ text: "x", evidence: [entry("E1", "return 1;")] })) };
    expect(parseModelOutput(JSON.stringify(many)).ok).toBe(false);
    expect(parseModelOutput(JSON.stringify({ status: "answered", claims: [{ text: "x".repeat(5000), evidence: [entry("E1", "return 1;")] }] })).ok).toBe(false);
  });
});

describe("quoteIsVerbatim", () => {
  it("ignores whitespace runs and line-number prefixes", () => {
    expect(quoteIsVerbatim("export function   alpha() {", E1)).toBe(true);
    expect(quoteIsVerbatim("L10| export function alpha() {\nL11|   return 1;", E1)).toBe(true);
  });

  it("rejects text that is not in the named block, even though it is in another block", () => {
    expect(quoteIsVerbatim("const beta = 2;", E1)).toBe(false);
    expect(quoteIsVerbatim("const beta = 2;", E2)).toBe(true);
    expect(quoteIsVerbatim("ab", E1)).toBe(false);
  });

  it("rejects a quote that stitches together lines that are not adjacent in the block", () => {
    expect(quoteIsVerbatim("export function alpha() {\n}", E1)).toBe(false);
  });
});

describe("validateAnswer", () => {
  const answer = (claims: { text: string; evidence: { citation: string; quote: string }[] }[]) => validateAnswer({ status: "answered", claims }, registry());

  it("passes claims whose citations and quotes check out, and records each quote against its own id", () => {
    const v = answer([{ text: "alpha returns 1", evidence: [entry("E1", "return 1;")] }]);
    expect(v.status).toBe("answered");
    expect(v.rejections).toEqual([]);
    expect(v.claims[0]).toMatchObject({ status: "cited", quoteVerbatim: true, citations: [{ id: "E1", verdict: { valid: true }, quote: "return 1;", quoteVerbatim: true }] });
  });

  it("accepts two passages from two blocks when each is given as its own entry", () => {
    const v = answer([{ text: "alpha returns 1 and beta is 2", evidence: [entry("E1", "return 1;"), entry("E2", "const beta = 2;")] }]);
    expect(v.status).toBe("answered");
    expect(v.claims[0]?.citations.map((c) => c.quoteVerbatim)).toEqual([true, true]);
  });

  it("rejects a real quote attributed to the wrong block", () => {
    const v = answer([{ text: "alpha", evidence: [entry("E1", "const beta = 2;")] }]);
    expect(v.status).toBe("rejected");
    expect(v.claims[0]).toMatchObject({ status: "quote-mismatch", quoteVerbatim: false });
    expect(v.rejections).toEqual([{ code: "quote-not-in-citation", claim: 1, citation: "E1" }]);
  });

  it("rejects the claim when one of two entries has its quotes swapped, and names the entries at fault", () => {
    const v = answer([{ text: "alpha and beta", evidence: [entry("E1", "const beta = 2;"), entry("E2", "return 1;")] }]);
    expect(v.status).toBe("rejected");
    expect(v.rejections.map((r) => r.citation)).toEqual(["E1", "E2"]);
    const one = answer([{ text: "alpha and beta", evidence: [entry("E1", "return 1;"), entry("E2", "return 1;")] }]);
    expect(one.rejections).toEqual([{ code: "quote-not-in-citation", claim: 1, citation: "E2" }]);
    expect(one.claims[0]?.citations.map((c) => c.quoteVerbatim)).toEqual([true, false]);
  });

  it("rejects one quote that joins text from two blocks, which the older rule let stand for a passage", () => {
    const v = answer([{ text: "alpha returns 1 and beta is 2", evidence: [entry("E1", "return 1;\nconst beta = 2;")] }]);
    expect(v.status).toBe("rejected");
    expect(v.claims[0]?.status).toBe("quote-mismatch");
  });

  it("rejects the whole answer when any citation is fabricated", () => {
    const v = answer([{ text: "ok", evidence: [entry("E1", "return 1;")] }, { text: "made up", evidence: [entry("E7", "return 1;")] }]);
    expect(v.status).toBe("rejected");
    expect(v.reasons.join(" ")).toContain("E7:unknown-evidence-id");
    expect(v.claims[1]).toMatchObject({ status: "invalid-citation", quoteVerbatim: false });
    expect(v.rejections).toEqual([{ code: "invalid-citation", claim: 2, citation: "E7", detail: "unknown-evidence-id" }]);
  });

  it("never treats a quote as verified when the id it is attached to does not exist", () => {
    const v = answer([{ text: "x", evidence: [entry("src/a.ts", "return 1;")] }]);
    expect(v.claims[0]?.citations[0]).toMatchObject({ verdict: { valid: false }, quoteVerbatim: false });
  });

  it("rejects uncited claims unless explicitly allowed", () => {
    const strict = answer([{ text: "no citation", evidence: [] }]);
    expect(strict.status).toBe("rejected");
    expect(strict.rejections).toEqual([{ code: "uncited-claim", claim: 1 }]);
    const lenient = validateAnswer({ status: "answered", claims: [{ text: "no citation", evidence: [] }] }, registry(), { requireCitations: false });
    expect(lenient.status).toBe("answered");
    expect(lenient.claims[0]).toMatchObject({ status: "uncited", quoteVerbatim: null });
  });

  it("passes an insufficient-evidence reply through with no claims", () => {
    expect(validateAnswer({ status: "insufficient_evidence", missing: "x" }, registry())).toMatchObject({ status: "insufficient_evidence", claims: [], rejections: [], missing: "x" });
  });

  it("never reports semantic support: a valid citation with a verbatim quote is only that", () => {
    const v = answer([{ text: "this repository is secure", evidence: [entry("E2", "const beta = 2;")] }]);
    expect(v.status).toBe("answered");
    expect(JSON.stringify(v)).not.toMatch(/support/i);
  });

  it("keeps rejection details to machine codes, never model or repository text", () => {
    const v = answer([{ text: "SECRET-CLAIM-TEXT", evidence: [entry("E1", "SECRET-QUOTE-TEXT"), entry("E9", "SECRET-QUOTE-TEXT")] }]);
    expect(JSON.stringify(v.rejections)).not.toContain("SECRET");
  });
});

describe("citation validation against an independent oracle", () => {
  // Seeded generator: the same inputs on every run.
  let seed = 123456789;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  function oracle(c: { id: string; owner?: string; repo?: string; sha?: string; path?: string; startLine?: number; endLine?: number }): boolean {
    const e = [E1, E2].find((x) => x.id === c.id);
    if (!e) return false;
    if (c.owner !== undefined && c.owner !== "acme") return false;
    if (c.repo !== undefined && c.repo !== "shop") return false;
    if (c.sha !== undefined && c.sha !== REPO.sha) return false;
    if (c.path !== undefined && c.path !== e.path) return false;
    if (c.startLine === undefined && c.endLine === undefined) return true;
    const a = c.startLine ?? c.endLine!;
    const b = c.endLine ?? c.startLine!;
    return Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a && b <= e.fileLineCount && a >= e.startLine && b <= e.endLine;
  }

  it("agrees with the oracle on 5,000 random citations and never accepts a malformed one", () => {
    const reg = registry();
    let accepted = 0;
    for (let i = 0; i < 5000; i++) {
      const c = {
        id: pick(["E1", "E2", "E3", "", "e1", "E1 ", "../E1"]),
        owner: pick([undefined, "acme", "evil"]),
        repo: pick([undefined, "shop", "other"]),
        sha: pick([undefined, REPO.sha, "b".repeat(40)]),
        path: pick([undefined, "src/a.ts", "src/b.ts", "../../x"]),
        startLine: pick([undefined, -1, 0, 1, 5, 10, 12, 15, 20, 21, 99, 1000, 2.5, Number.NaN]),
        endLine: pick([undefined, -1, 0, 1, 5, 10, 12, 15, 20, 21, 99, 1000, 2.5, Number.NaN]),
      };
      const got = reg.check(c).valid;
      expect(got, JSON.stringify(c)).toBe(oracle(c));
      if (got) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(5); // guards against a vacuous run where nothing is ever valid
  });
});

describe("optional unsupported list", () => {
  it("is accepted when short and rejected when malformed", () => {
    const base = { status: "insufficient_evidence", missing: "x" };
    expect(parseModelOutput(JSON.stringify({ ...base, unsupported: ["cookies"] }))).toMatchObject({ ok: true, output: { unsupported: ["cookies"] } });
    expect(parseModelOutput(JSON.stringify({ ...base, unsupported: "cookies" })).ok).toBe(false);
    expect(parseModelOutput(JSON.stringify({ ...base, unsupported: Array(9).fill("x") })).ok).toBe(false);
  });
});

describe("why an evidence entry is malformed", () => {
  const wrap = (entry: unknown) => JSON.stringify({ status: "answered", claims: [{ text: "t", evidence: [entry] }] });

  it("names an over-long quote separately from a missing or empty one, and still rejects both", () => {
    expect(parseModelOutput(wrap({ citation: "E1", quote: "x".repeat(401) }))).toEqual({ ok: false, reason: "an evidence quote is longer than 400 characters", code: "quote-too-long" });
    for (const bad of [{ citation: "E1", quote: "" }, { citation: "E1" }, { quote: "abc" }, "E1", null, { citation: "", quote: "abc" }]) {
      expect(parseModelOutput(wrap(bad))).toEqual({ ok: false, reason: "each evidence entry needs one citation id and its own quote" });
    }
    expect(parseModelOutput(wrap({ citation: "E1", quote: "x".repeat(400) })).ok).toBe(true);
  });
});

describe("evidence contract 3: a long quote is checked in full, then kept trimmed", () => {
  const body = Array.from({ length: 30 }, (_, i) => `  const value${i} = compute(${i}, "padding to make the line longer");`);
  const text = ["export function long() {", ...body, "  return value0;", "}"].join("\n");
  const BIG = item("E1", "src/long.ts", 1, 33, text);
  const reg = () => new EvidenceRegistry([BIG], REPO);
  const reply = (quote: string) => JSON.stringify({ status: "answered", claims: [{ text: "long() computes thirty values.", evidence: [{ citation: "E1", quote }] }] });
  const validate = (quote: string) => {
    const parsed = parseModelOutput(reply(quote), 3);
    if (!parsed.ok) throw new Error(parsed.reason);
    return validateAnswer(parsed.output, reg());
  };

  it("contract 2, the application's, is unchanged: told nothing, the parser refuses a quote over 400 characters", () => {
    expect(DEFAULT_EVIDENCE_CONTRACT).toBe(2);
    expect(EVIDENCE_CONTRACT).toBe(3);
    expect(text.length).toBeGreaterThan(1000);
    expect(parseModelOutput(reply(text))).toEqual({ ok: false, reason: "an evidence quote is longer than 400 characters", code: "quote-too-long" });
    expect(parseModelOutput(reply(text), 2)).toEqual(parseModelOutput(reply(text)));
  });

  it("accepts a long quote that is verbatim, and keeps its first lines only", () => {
    const out = validate(text);
    expect(out.status).toBe("answered");
    const c = out.claims[0]!.citations[0]!;
    expect(c).toMatchObject({ id: "E1", quoteVerbatim: true, quoteTrimmed: true });
    expect(c.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    // Cut at a line end, and what is kept is itself a verbatim passage of the block.
    expect(text.startsWith(c.quote)).toBe(true);
    expect(text[c.quote.length]).toBe("\n");
    expect(quoteIsVerbatim(c.quote, BIG)).toBe(true);
  });

  it("checks the whole quote before trimming: a long quote that goes wrong after its 400th character still fails", () => {
    const altered = `${text.slice(0, 900)}THIS IS NOT IN THE FILE${text.slice(900)}`;
    expect(text.slice(0, 400)).toBe(altered.slice(0, 400));
    const out = validate(altered);
    expect(out.status).toBe("rejected");
    expect(out.rejections).toEqual([{ code: "quote-not-in-citation", claim: 1, citation: "E1" }]);
    // Even a refused quote is not kept at length.
    expect(out.claims[0]!.citations[0]!.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(out.claims[0]!.citations[0]).toMatchObject({ quoteVerbatim: false, quoteTrimmed: true });
  });

  it("leaves a quote within the limit exactly as it was, with no trimmed mark", () => {
    const short = validate("export function long() {");
    expect(short.claims[0]!.citations[0]).toEqual({ id: "E1", verdict: { valid: true }, quote: "export function long() {", quoteVerbatim: true });
  });

  it("still refuses, unread, a quote beyond the hard ceiling", () => {
    expect(parseModelOutput(reply("y".repeat(MAX_RAW_QUOTE_CHARS)), 3).ok).toBe(true);
    expect(parseModelOutput(reply("y".repeat(MAX_RAW_QUOTE_CHARS + 1)), 3)).toEqual({ ok: false, reason: "an evidence quote is longer than 4000 characters", code: "quote-too-long" });
  });

  it("trims at the last line end inside the limit, or at the limit when the quote has no line end", () => {
    expect(trimQuote("short")).toBe("short");
    expect(trimQuote("z".repeat(900))).toHaveLength(MAX_QUOTE_CHARS);
    const lines = `${"a".repeat(150)}\n${"b".repeat(150)}\n${"c".repeat(150)}`;
    expect(trimQuote(lines)).toBe(`${"a".repeat(150)}\n${"b".repeat(150)}`);
  });
});
