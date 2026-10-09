/**
 * Produces /api/answer responses for the browser check WITHOUT calling a language model.
 *
 * Each response is what the real server pipeline returns (real index, real retrieval, real source fetch at the pinned commit,
 * real citation validation) with the model step replaced by a stand-in. They exist so the UI's states can be exercised when no
 * model quota is available. They say nothing about how a real model answers.
 *
 *   npx tsx e2e/make-answer-fixtures.ts <owner/name> <sha> <index-store-dir> <out-dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExtractiveBaselineProvider, ProviderError, type ModelProvider } from "../src/answer/provider";
import { parsePromptEvidence } from "../src/answer/prompt";
import { handleAnswer } from "../src/server/answer-handler";

const [repo, sha, storeDir, outDir] = process.argv.slice(2);
if (!repo || !sha || !storeDir || !outDir) throw new Error("usage: make-answer-fixtures <owner/name> <sha> <index-store-dir> <out-dir>");
process.env.INDEX_STORE_DIR = path.resolve(storeDir);
const { getSharedSource, loadCachedIndex } = await import("../src/server/runtime");

const scripted = (reply: (firstEvidenceId: string) => string): ModelProvider => ({
  name: "scripted-stand-in",
  async complete(request) {
    const first = parsePromptEvidence(request.user, request.nonce).blocks[0]?.id ?? "E1";
    return reply(first);
  },
});

const QUESTION = "What does the separator option do and what is its default value?";

const cases: { name: string; question: string; provider: ModelProvider; expect: string }[] = [
  { name: "answered", question: QUESTION, provider: new ExtractiveBaselineProvider(), expect: "answered" },
  { name: "insufficient-search", question: "kubernetes operator reconciliation quantum ledger", provider: new ExtractiveBaselineProvider(), expect: "insufficient_evidence" },
  {
    name: "insufficient-model",
    question: QUESTION,
    provider: scripted(() => JSON.stringify({ status: "insufficient_evidence", missing: "The evidence does not show how the option is applied to non-Latin scripts." })),
    expect: "insufficient_evidence",
  },
  {
    name: "rejected",
    question: QUESTION,
    provider: scripted((id) => JSON.stringify({ status: "answered", claims: [{ text: "The separator is always a tilde.", evidence: [{ citation: id, quote: "this text does not appear in the cited lines" }]}] })),
    expect: "rejected",
  },
  {
    name: "provider-rate-limited",
    question: QUESTION,
    provider: {
      name: "groq",
      async complete() {
        throw new ProviderError("rate_limited", 429);
      },
    },
    expect: "provider_error",
  },
  {
    // A question the application answers partly itself, from its index: who imports a module.
    name: "index-fact",
    question: "Which modules import the overridable replacements module?",
    provider: new ExtractiveBaselineProvider(),
    expect: "answered",
  },
  {
    // The stand-in quotes a whole block, well over what is kept: the quote is checked in full and returned shortened.
    name: "long-quote",
    question: QUESTION,
    provider: {
      name: "scripted-stand-in",
      async complete(request) {
        const block = parsePromptEvidence(request.user, request.nonce).blocks.find((b) => b.lines.join("\n").length > 450 && b.lines.join("\n").length < 3500);
        if (!block) throw new Error("no evidence block of a suitable length to quote in full");
        return JSON.stringify({ status: "answered", claims: [{ text: "The cited block is quoted here in full.", evidence: [{ citation: block.id, quote: block.lines.join("\n") }] }] });
      },
    },
    expect: "answered",
  },
];

mkdirSync(outDir, { recursive: true });
const summary: Record<string, unknown> = { repo, sha };
for (const c of cases) {
  const out = await handleAnswer(
    { provider: c.provider, loadIndex: async (key) => (await loadCachedIndex(key))?.index ?? null, makeSource: getSharedSource },
    { repo, sha, question: c.question },
  );
  const body = out.body as { status?: string; claims?: { citations?: { quoteTrimmed?: boolean }[] }[]; evidence?: unknown[]; indexFacts?: unknown[] };
  if (body.status !== c.expect) throw new Error(`${c.name}: expected ${c.expect}, the pipeline returned ${body.status} (HTTP ${out.status})`);
  // A fixture that does not show what it exists to show would let the browser check pass on nothing.
  if (c.name === "index-fact" && !(body.indexFacts && body.indexFacts.length > 0)) throw new Error("index-fact: the pipeline stated no fact from the index for this question");
  if (c.name === "long-quote" && !body.claims?.some((cl) => cl.citations?.some((x) => x.quoteTrimmed === true))) throw new Error("long-quote: no quote came back shortened");
  writeFileSync(path.join(outDir, `${c.name}.json`), JSON.stringify({ httpStatus: out.status, question: c.question, body }));
  summary[c.name] = { httpStatus: out.status, status: body.status, claims: body.claims?.length ?? 0, evidence: body.evidence?.length ?? 0 };
}
console.log(JSON.stringify(summary));
