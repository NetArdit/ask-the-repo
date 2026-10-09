import { describe, expect, it } from "vitest";
import { IndexBuilder } from "../index/build";
import { languageOf } from "../ingest/filter";
import { parseSource } from "../parse/extract";
import { DEFAULT_INDEX_CONFIG } from "../retrieve/defaults";
import { LoadedIndex } from "../retrieve/loaded-index";
import { answerQuestion } from "./answer";
import { declaringLine, entryCandidates, entryNote, findEntries } from "./entries";
import type { ModelProvider, ModelRequest } from "./provider";
import { MapSource } from "./source";
import { TEST_REPO, deps } from "./test-helpers";

/** Like the shared fixture, but with configuration files indexed, which is what fills the entry table. */
async function build(files: Record<string, string>) {
  const builder = new IndexBuilder({ owner: TEST_REPO.owner, repo: TEST_REPO.repo, sha: TEST_REPO.sha }, { ...DEFAULT_INDEX_CONFIG });
  for (const [path, text] of Object.entries(files)) builder.addFile(await parseSource(path, languageOf(path), text), text, Buffer.byteLength(text));
  return { index: new LoadedIndex(builder.finish()), source: new MapSource(new Map(Object.entries(files))) };
}

const padding = Array.from({ length: 30 }, (_, i) => `    "dep-${i}": "^1.0.${i}"`).join(",\n");
const SINGLE: Record<string, string> = {
  "package.json": `{\n  "name": "shop",\n  "version": "1.0.0",\n  "description": "a shop",\n  "dependencies": {\n${padding}\n  },\n  "main": "./lib/main.js",\n  "exports": {\n    ".": "./lib/main.js",\n    "./cart": "./lib/cart.js"\n  }\n}\n`,
  "lib/main.js": ["'use strict'", "", "const cart = require('./cart.js')", "", "module.exports = function createShop () {", "  return { cart }", "}", ""].join("\n"),
  "lib/cart.js": ["'use strict'", "", "module.exports = function createCart () {", "  return { items: [] }", "}", ""].join("\n"),
  "lib/unused.js": ["module.exports = function unused () {", "  return 1", "}", ""].join("\n"),
};
const MONO: Record<string, string> = {
  "packages/alpha/package.json": '{\n  "name": "alpha",\n  "main": "index.js"\n}\n',
  "packages/alpha/index.js": ["export function alpha() {", "  return 1;", "}", ""].join("\n"),
  "packages/beta/package.json": '{\n  "name": "@acme/beta",\n  "main": "index.js"\n}\n',
  "packages/beta/index.js": ["export function beta() {", "  return 2;", "}", ""].join("\n"),
};

class Recorder implements ModelProvider {
  readonly name = "recorder";
  last: ModelRequest | null = null;
  constructor(private readonly reply = '{"status":"insufficient_evidence","missing":"x"}') {}
  async complete(request: ModelRequest): Promise<string> {
    this.last = request;
    return this.reply;
  }
}

describe("findEntries", () => {
  it("reads the declared entry points of the package from the index, main first, with the manifest that declares them", async () => {
    const { index } = await build(SINGLE);
    const fact = findEntries(index, "What is the entry point of shop?", "shop")!;
    expect(fact.pkg).toBe("shop");
    expect(fact.manifest).toBe("package.json");
    expect(fact.entries[0]).toEqual({ path: "lib/main.js", entryKind: "main" });
    expect(fact.entries.map((e) => e.path)).toContain("lib/cart.js");
    expect(fact.entries.map((e) => e.path)).not.toContain("lib/unused.js");
    // lib/main.js is named by "main" and by the exports map: each (kind, file) pair appears once.
    const keys = fact.entries.map((e) => `${e.entryKind} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("asks nothing of the index for other questions, and recognises the usual ways of asking", async () => {
    const { index } = await build(SINGLE);
    for (const q of ["Where is createCart defined?", "Which modules import cart?", "How does the shop work?", "What does main do?"]) expect(findEntries(index, q, "shop"), q).toBeNull();
    for (const q of ["What is the entry point?", "which file is the entry-point of this package", "Where are the package exports declared?", "What is the main file?", "where is the exports map"]) expect(findEntries(index, q, "shop"), q).not.toBeNull();
  });

  it("with several packages, answers only when the question or the repository says which one is meant", async () => {
    const { index } = await build(MONO);
    expect(findEntries(index, "What is the entry point of the alpha package?", "mono")!.entries).toEqual([{ path: "packages/alpha/index.js", entryKind: "main" }]);
    expect(findEntries(index, "What is the entry point of beta?", "mono")).toMatchObject({ pkg: "@acme/beta", manifest: "packages/beta/package.json" });
    expect(findEntries(index, "What is the entry point?", "mono")).toBeNull();
    expect(findEntries(index, "What is the entry point of alpha and beta?", "mono")).toBeNull();
    // The repository is named after one of its packages: that one is meant when none is named.
    expect(findEntries(index, "What is the entry point?", "alpha")!.pkg).toBe("alpha");
    // No declared entries at all.
    const none = await build({ "src/a.ts": "export const a = 1;\nexport const b = 2;\n" });
    expect(findEntries(none.index, "What is the entry point?", "shop")).toBeNull();
  });
});

describe("entry evidence in the pipeline", () => {
  const QUESTION = "What is the entry point of shop?";

  it("finds the manifest line that declares the entry and offers its chunk, then the entry file's exports", async () => {
    const { index, source } = await build(SINGLE);
    const fact = findEntries(index, QUESTION, "shop")!;
    const line = await declaringLine(fact, (p) => source.getFile(TEST_REPO, p));
    expect(SINGLE["package.json"]!.split("\n")[line! - 1]).toContain('"main": "./lib/main.js"');
    const found = entryCandidates(index, fact, line, [], { maxBlocks: 2 });
    expect(found.map((c) => c.path)).toEqual(["package.json", "lib/main.js"]);
    expect(found[0]!.startLine).toBeLessThanOrEqual(line!);
    expect(found[0]!.endLine).toBeGreaterThanOrEqual(line!);
    // Already shown, or no declaring line found: not offered.
    expect(entryCandidates(index, fact, line, [{ path: "package.json", startLine: 1, endLine: 999 }], { maxBlocks: 2 }).map((c) => c.path)).toEqual(["lib/main.js"]);
    expect(entryCandidates(index, fact, null, [], { maxBlocks: 2 }).map((c) => c.path)).toEqual(["lib/main.js"]);
    expect(await declaringLine(fact, async () => null)).toBeNull();
    expect(await declaringLine(fact, async () => '{ "name": "shop" }')).toBeNull();
  });

  it("is off by default; when on, the declaring lines are in the evidence and the application states the entries", async () => {
    const { index, source } = await build(SINGLE);
    const off = new Recorder();
    const before = await answerQuestion(deps({ index, source, provider: off, maxEvidence: 1 }), QUESTION);
    expect(before.indexFacts).toBeUndefined();
    expect(off.last?.user ?? "").not.toContain(" INDEX ");

    const on = new Recorder();
    const after = await answerQuestion({ ...deps({ index, source, provider: on, maxEvidence: 1 }), entryEvidence: { maxBlocks: 2 } }, QUESTION);
    expect(after.evidence[0]).toEqual(before.evidence[0]);
    expect(after.indexFacts).toMatchObject([{ kind: "entries", pkg: "shop", manifest: "package.json" }]);
    const note = on.last!.user.split("\n").find((l) => l.includes(" INDEX "))!;
    expect(note).toContain("entry points of package shop, as the index resolved them: main -> lib/main.js");
    expect(note).toMatch(/Declared in package\.json; the declaring lines are shown in evidence as E\d+\.$/);
    // The model can cite the declaring line, and the citation validates.
    const manifest = after.evidence.find((e) => e.path === "package.json" && on.last!.user.includes('"main": "./lib/main.js"'))!;
    const reply = JSON.stringify({ status: "answered", claims: [{ text: "package.json declares lib/main.js as the main entry.", evidence: [{ citation: manifest.id, quote: '"main": "./lib/main.js"' }] }] });
    const cited = await answerQuestion({ ...deps({ index, source, provider: new Recorder(reply), maxEvidence: 1 }), entryEvidence: { maxBlocks: 2 } }, QUESTION);
    expect(cited.status).toBe("answered");
    expect(cited.claims[0]!.citations[0]).toMatchObject({ verdict: { valid: true }, quoteVerbatim: true });
  });

  it("words the note for a manifest that is missing or not shown", () => {
    const fact = { kind: "entries" as const, pkg: "p", entries: [{ path: "index.js", entryKind: "main" }], manifest: "package.json" };
    expect(entryNote(fact, 3, [])).toContain("Declared in package.json; its declaring lines are not among the evidence.");
    expect(entryNote(fact, 3, [{ id: "E2", path: "package.json", startLine: 10, endLine: 20 }])).toContain("its declaring lines are not among the evidence");
    expect(entryNote(fact, 3, [{ id: "E2", path: "package.json", startLine: 1, endLine: 5 }])).toContain("shown in evidence as E2");
    expect(entryNote({ ...fact, manifest: null }, null, [])).toContain("The declaring manifest is not an indexed file.");
    // A manifest with no entry field: the note does not say "declared in".
    const implicit = entryNote(fact, null, [{ id: "E2", path: "package.json", startLine: 1, endLine: 5 }]);
    expect(implicit).toContain("no line declaring an entry field was found in it");
    expect(implicit).not.toContain("Declared in");
    const many = { ...fact, entries: Array.from({ length: 9 }, (_, i) => ({ path: `e${i}.js`, entryKind: "exports" })) };
    expect(entryNote(many, null, [])).toContain("(+3 more)");
  });
});
