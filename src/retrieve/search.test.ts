import { describe, expect, it } from "vitest";
import { countLines, lineWindows } from "../parse/chunk";
import { parseSource } from "../parse/extract";
import { IndexBuilder } from "../index/build";
import { BASELINE_CONFIG, type IndexConfig } from "../index/types";
import { LoadedIndex } from "./loaded-index";
import { search } from "./search";

const KEY = { owner: "acme", repo: "app", sha: "c".repeat(40) };

async function index(files: Record<string, string>, config: IndexConfig = { ...BASELINE_CONFIG, includeConfig: true }): Promise<LoadedIndex> {
  const b = new IndexBuilder(KEY, config);
  for (const [p, text] of Object.entries(files)) {
    if (p.endsWith(".json")) {
      const lineCount = countLines(text);
      b.addFile({ path: p, language: "config", status: "text", failureReason: null, lineCount, symbols: [], imports: [], exports: [], chunks: lineWindows(lineCount), parseMs: 0 }, text, text.length);
    } else b.addFile(await parseSource(p, "typescript", text), text, text.length);
  }
  return new LoadedIndex(b.finish());
}

const RETRY = "export function retryRequest(attempts: number) {\n  return attempts > 0 ? retryRequest(attempts - 1) : null;\n}\n";

describe("test and example demotion", () => {
  const files = { "src/retry.ts": RETRY, "test/retry.test.ts": `${RETRY}// retry retry retry\n`, "examples/retry.ts": RETRY };
  const weights = { test: 0.3, example: 0.3, docs: 0.3 };

  it("ranks production source above a test with the same content, without dropping the test", async () => {
    const idx = await index(files);
    const plain = search(idx, "where is retry implemented", {});
    const demoted = search(idx, "where is retry implemented", { classWeights: weights });
    expect(demoted.evidence[0]?.path).toBe("src/retry.ts");
    expect(demoted.evidence.map((e) => e.path)).toEqual(expect.arrayContaining(["test/retry.test.ts", "examples/retry.ts"]));
    expect(plain.evidence.length).toBe(demoted.evidence.length);
  });

  it("does not demote when the question asks about tests", async () => {
    const idx = await index(files);
    const r = search(idx, "which tests cover retry", { classWeights: weights });
    expect(r.evidence[0]?.path).toBe("test/retry.test.ts");
  });
});

describe("entry-point boost", () => {
  const files = {
    "packages/core/package.json": JSON.stringify({ name: "core", main: "./dist/index.js" }),
    "packages/core/src/index.ts": "export const core = 1;\n",
    "packages/core/src/server.ts": "export function startServer() { return 1; }\n// entry point of the server startup\n",
    "packages/cli/package.json": JSON.stringify({ name: "cli", bin: { cli: "./src/bin.ts" } }),
    "packages/cli/src/bin.ts": "export const bin = 1;\n",
  };

  it("surfaces the declared package entry for entry-point questions", async () => {
    const idx = await index(files);
    const r = search(idx, "What is the entry point of the core package?", { entryBoost: true, entryWeight: 1.2 });
    expect(r.evidence[0]?.path).toBe("packages/core/src/index.ts");
  });

  it("leaves other questions alone", async () => {
    const idx = await index(files);
    const a = search(idx, "where is startServer defined", {});
    const b = search(idx, "where is startServer defined", { entryBoost: true, entryWeight: 1.2 });
    expect(b.evidence.map((e) => e.path)).toEqual(a.evidence.map((e) => e.path));
  });

  it("finds configuration through indexed package.json when asked about it", async () => {
    const idx = await index({ ...files, "packages/core/src/util.ts": "export const exportsHelper = 1;\n" });
    const r = search(idx, "where are the package exports and main declared", {});
    expect(r.evidence.slice(0, 3).some((e) => e.path.endsWith("package.json"))).toBe(true);
  });
});

describe("abstention features", () => {
  it("scores lower coverage for a question the repository cannot answer", async () => {
    const idx = await index({ "src/retry.ts": RETRY });
    const hit = search(idx, "where is retryRequest implemented", {});
    const miss = search(idx, "where is the kubernetes autoscaler configured", {});
    expect(hit.features.idfCoverage).toBeGreaterThan(miss.features.idfCoverage);
    expect(hit.features.exactSymbolInTop3).toBe(true);
  });
});
