import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePromptEvidence } from "../answer/prompt";
import { ProviderError, type ModelProvider } from "../answer/provider";
import { EVIDENCE_CONTRACT } from "../answer/validate";
import { CACHE_ROOT } from "./cache";
import { runAnswers, type AnswerRecord, type PolicyVariant, type PrivateRecord } from "./answer-eval";

// Uses the real tuning split and the locally cached indexes; a scripted stand-in replaces the model.
const HAVE_CACHE = existsSync(path.join(CACHE_ROOT, "index")) && existsSync(path.join(CACHE_ROOT, "tarballs"));
const POLICY: PolicyVariant = { name: "records-test", policy: { insufficientBelow: 0, cautionBelow: 0 }, captionDeclines: false };
const SECRET = "gsk_never_written_anywhere_0123456789";

const lines = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as T);

describe.skipIf(!HAVE_CACHE)("evaluation records", () => {
  it("keeps the raw reply, the quotes and structured reasons in the private record, and none of the source text in the public one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "answer-records-"));
    const checkpointFile = path.join(dir, "public.jsonl");
    const privateFile = path.join(dir, "private", "raw.jsonl");
    const replies: string[] = [];
    const provider: ModelProvider = {
      name: "scripted-stand-in",
      async complete(request) {
        if (replies.length === 3) throw new ProviderError("rate_limited", 429, 1000, { status: 429, headers: { "retry-after": "1" } });
        const block = parsePromptEvidence(request.user, request.nonce).blocks[0]!;
        const real = block.lines.find((l) => l.trim().length > 8)!.trim();
        const reply =
          replies.length === 0
            ? // 1: a claim whose quote is really in the block it names
              JSON.stringify({ status: "answered", claims: [{ text: "first claim", evidence: [{ citation: block.id, quote: real }] }] })
            : replies.length === 1
              ? // 2: a quote that is not in the block, and an id that was never offered
                JSON.stringify({ status: "answered", claims: [{ text: "second claim", evidence: [{ citation: block.id, quote: "QUOTE-NOT-IN-THE-BLOCK" }, { citation: "E99", quote: real }] }] })
              : // 3: the shape used before the evidence contract
                JSON.stringify({ status: "answered", claims: [{ text: "third claim", citations: [block.id], quote: real }] });
        replies.push(reply);
        return reply;
      },
    };
    const run = await runAnswers("tuning", POLICY, () => provider, { checkpointFile, privateFile, model: "stand-in/model", promptVariant: "B" });

    expect(run).toMatchObject({ evidenceContract: EVIDENCE_CONTRACT, model: "stand-in/model", promptVariant: "B" });
    expect(run.halted).toBeDefined();
    expect(run.providerFailures).toEqual([{ id: run.halted!.nextId, kind: "rate_limited", status: 429, rateLimit: { status: 429, headers: { "retry-after": "1" } } }]);
    const pub = lines<AnswerRecord>(checkpointFile);
    const priv = lines<PrivateRecord>(privateFile);
    expect(priv.map((r) => r.id)).toEqual(pub.map((r) => r.id)); // one private record per checkpointed case, same order
    expect(priv).toHaveLength(3);

    // Private: enough to reproduce the scoring and debug it.
    expect(priv.map((r) => r.raw)).toEqual(replies);
    expect(priv.every((r) => r.evidenceContract === EVIDENCE_CONTRACT && r.promptVariant === "B" && r.model === "stand-in/model" && r.variant === "records-test" && r.split === "tuning")).toBe(true);
    expect(priv.every((r) => /^[0-9a-f]{40}$/.test(r.sha) && r.question.length > 0 && r.offered.length > 0)).toBe(true);
    expect(priv[0]).toMatchObject({ status: "answered", rejections: [] });
    expect(priv[0]!.claims[0]!.citations[0]).toMatchObject({ quoteVerbatim: true, quote: expect.any(String) });
    expect(priv[1]).toMatchObject({ status: "rejected" });
    expect(priv[1]!.rejections).toEqual([{ code: "invalid-citation", claim: 1, citation: "E99", detail: "unknown-evidence-id" }]);
    expect(priv[2]).toMatchObject({ status: "rejected", claims: [] });
    expect(priv[2]!.rejections).toEqual([{ code: "malformed-output", detail: "claim evidence must be a list of {citation, quote}" }]);

    // Public: verdicts and reasons, but no reply and no quoted source.
    expect(pub.map((r) => r.status)).toEqual(["answered", "rejected", "rejected"]);
    expect(pub[1]!.rejections).toEqual(priv[1]!.rejections);
    expect(pub[2]!.reasons[0]).toContain("malformed model output");
    expect(pub[0]!.claims[0]!.citations[0]).toEqual({ id: priv[0]!.claims[0]!.citations[0]!.id, valid: true, quoteVerbatim: true });
    const publicText = readFileSync(checkpointFile, "utf8");
    expect(publicText).not.toContain("QUOTE-NOT-IN-THE-BLOCK");
    expect(publicText).not.toContain(priv[0]!.claims[0]!.citations[0]!.quote);
    expect(publicText).not.toContain('"raw"');
    expect(publicText).not.toContain('"quote"');

    // Neither file holds a credential.
    expect(publicText + readFileSync(privateFile, "utf8")).not.toContain(SECRET);
  }, 180_000);

  it("writes no private record for a case the model was never asked about, and none when no private file is given", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "answer-records-"));
    const checkpointFile = path.join(dir, "public.jsonl");
    const provider: ModelProvider = {
      name: "scripted-stand-in",
      async complete() {
        throw new ProviderError("rate_limited", 429, 1000, { status: 429, headers: { "retry-after": "1" } });
      },
    };
    await runAnswers("tuning", POLICY, () => provider, { checkpointFile });
    expect(existsSync(path.join(dir, "private"))).toBe(false);
  }, 180_000);
});
