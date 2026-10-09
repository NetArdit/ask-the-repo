import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError, type ModelProvider } from "../answer/provider";
import { CACHE_ROOT } from "./cache";
import { runAnswers, type PolicyVariant } from "./answer-eval";

// Uses the real tuning split and the locally cached indexes; no model is called (a counting stub stands in for the provider).
const HAVE_CACHE = existsSync(path.join(CACHE_ROOT, "index")) && existsSync(path.join(CACHE_ROOT, "tarballs"));
const VARIANT: PolicyVariant = { name: "resume-test", policy: { insufficientBelow: 0, cautionBelow: 0 }, captionDeclines: false };
const VALID = JSON.stringify({ status: "insufficient_evidence", missing: "stub" });
const SECRET = "gsk_never_in_checkpoint";

function stub(behaviour: (call: number) => "ok" | ProviderError) {
  const calls: number[] = [];
  const provider: ModelProvider = {
    name: "stub",
    async complete() {
      calls.push(calls.length + 1);
      const r = behaviour(calls.length);
      if (r !== "ok") throw r;
      return VALID;
    },
  };
  return { provider, calls };
}

describe.skipIf(!HAVE_CACHE)("tuning runner checkpoint and resume", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "answer-resume-"));

  it("stops cleanly on a rate limit, then resumes without repeating any completed model call", async () => {
    const file = path.join(dir, "halt.jsonl");
    const first = stub((n) => (n <= 3 ? "ok" : new ProviderError("rate_limited", 429)));
    const run1 = await runAnswers("tuning", VARIANT, () => first.provider, { checkpointFile: file });
    expect(run1.halted).toBeDefined();
    expect(first.calls).toHaveLength(4); // 3 answered + the call that hit the limit
    expect(run1.providerFailures).toEqual([{ id: run1.halted!.nextId, kind: "rate_limited", status: 429 }]);
    expect(run1.records.every((r) => r.status !== "provider_error")).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(run1.records.length);
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);

    const second = stub(() => "ok");
    const run2 = await runAnswers("tuning", VARIANT, () => second.provider, { checkpointFile: file });
    expect(run2.halted).toBeUndefined();
    expect(run2.providerFailures).toEqual([]);
    expect(run2.resumed).toBe(run1.records.length);
    expect(run2.records).toHaveLength(run2.total!);
    expect(new Set(run2.records.map((r) => r.id)).size).toBe(run2.total);
    // Every case that needs a model call was made exactly once across both runs.
    const needingCalls = run2.records.filter((r) => r.stats.modelCalled).length;
    expect(3 + second.calls.length).toBe(needingCalls);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(run2.total!);
  }, 180_000);

  it("keeps a non-rate-limit provider failure out of the records and retries only that case on resume", async () => {
    const file = path.join(dir, "http.jsonl");
    const first = stub((n) => (n === 2 ? new ProviderError("http", 500) : "ok"));
    const run1 = await runAnswers("tuning", VARIANT, () => first.provider, { checkpointFile: file });
    expect(run1.halted).toBeUndefined();
    expect(run1.providerFailures).toHaveLength(1);
    expect(run1.records).toHaveLength(run1.total! - 1);
    expect(run1.records.some((r) => r.id === run1.providerFailures![0]!.id)).toBe(false);

    const second = stub(() => "ok");
    const run2 = await runAnswers("tuning", VARIANT, () => second.provider, { checkpointFile: file });
    expect(second.calls).toHaveLength(1);
    expect(run2.providerFailures).toEqual([]);
    expect(run2.records).toHaveLength(run2.total!);
  }, 180_000);
});
