/**
 * Deterministic re-validation of the stored tuning runs under evidence contract 3 (see src/answer/validate.ts). No model is
 * called: each case's reply is taken from the private record made when the run happened and validated again against the same
 * evidence blocks, read from the same pinned commit.
 *
 *   npx tsx scripts/revalidate-contract3.ts
 *
 * Contract 3 differs from contract 2 only for replies that contain a quote over 400 characters, and under contract 2 such a
 * reply was always withheld as `quote-too-long`. So only those cases are validated again; every other record is carried over
 * unchanged. The "-e2" result files are read and never written. For each one a "-e3" file is written beside it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerResult, CitedEvidence } from "../src/answer/answer";
import { permalink, stableEvidenceKey } from "../src/answer/evidence";
import type { EvidenceItem } from "../src/answer/types";
import { EvidenceRegistry, parseModelOutput, validateAnswer } from "../src/answer/validate";
import { record, type AnswerRecord, type AnswerRun, type PrivateRecord } from "../src/benchmark/answer-eval";
import { ensureTarball, openCachedTarball } from "../src/benchmark/cache";
import { loadAnswerSpecs, loadQuestions, loadRepos } from "../src/benchmark/dataset";
import { parseRepoRef } from "../src/github/repo-ref";
import { splitLines } from "../src/index/hash";
import { DEFAULT_LIMITS, ingestTarGz } from "../src/ingest/tarball";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "reports", "phase3");
const PRIVATE = path.join(ROOT, "reports", "private", "phase4b");
/** Result-file tag under contract 2, and the same run's tag under contract 3. */
const RUNS: [string, string][] = [
  ["A-e2", "A-e3"],
  ["B-e2", "B-e3"],
  ["C-e2", "C-e3"],
  ["D-e2", "D-e3"],
  ["E-e2-v3", "E-e3-v3"],
];

const questions = new Map(loadQuestions("tuning").map((q) => [q.id, q]));
const specs = new Map(loadAnswerSpecs("tuning").map((s) => [s.id, s]));
const repos = new Map(loadRepos().filter((r) => r.split === "tuning").map((r) => [r.repo, r]));
const sources = new Map<string, Map<string, string[]>>();

async function linesOf(repo: string, sha: string, file: string): Promise<string[]> {
  let files = sources.get(repo);
  if (!files) {
    files = new Map();
    await ingestTarGz(openCachedTarball(await ensureTarball(parseRepoRef(repo), sha)), DEFAULT_LIMITS, (f) => void files!.set(f.path, splitLines(f.content.toString("utf8"))), { includeConfig: true });
    sources.clear(); // one repository's source in memory at a time
    sources.set(repo, files);
  }
  const lines = files.get(file);
  if (!lines) throw new Error(`${repo}: ${file} is not in the pinned tarball`);
  return lines;
}

const summary: string[] = [];
for (const [from, to] of RUNS) {
  const fromFile = path.join(RESULTS, `answers.groq.run-0.3-0.5-${from}.tuning.json`);
  const privFile = path.join(PRIVATE, `answer-tuning-0.3-0.5-openai_gpt-oss-120b-${from}.raw.jsonl`);
  if (!existsSync(fromFile) || !existsSync(privFile)) throw new Error(`missing input for ${from}: this script substitutes nothing`);
  const run = JSON.parse(readFileSync(fromFile, "utf8")) as AnswerRun;
  const priv = new Map(readFileSync(privFile, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as PrivateRecord).map((r) => [r.id, r]));
  const changes: string[] = [];
  const records: AnswerRecord[] = [];
  for (const old of run.records) {
    const tooLong = old.status === "rejected" && old.rejections.some((r) => r.code === "quote-too-long");
    if (!tooLong) {
      records.push(old);
      continue;
    }
    const p = priv.get(old.id);
    if (!p || p.raw === null) throw new Error(`${from} ${old.id}: no stored reply to validate again`);
    const meta = repos.get(p.repo);
    if (!meta || meta.sha !== p.sha) throw new Error(`${from} ${old.id}: the stored reply is not for the pinned tuning commit`);
    const repo = { ...parseRepoRef(p.repo), sha: p.sha };
    const items: EvidenceItem[] = [];
    for (const o of p.offered) {
      const lines = await linesOf(p.repo, p.sha, o.path);
      const text = lines.slice(o.startLine - 1, o.endLine).join("\n");
      items.push({ id: o.id, key: stableEvidenceKey(repo, o.path, o.startLine, o.endLine), repo, path: o.path, startLine: o.startLine, endLine: o.endLine, text, chunkHash: "", fileLineCount: lines.length, score: 0, injectionSuspect: o.injectionSuspect });
    }
    const evidence: CitedEvidence[] = items.map((e) => ({ id: e.id, key: e.key, path: e.path, startLine: e.startLine, endLine: e.endLine, url: permalink(e), injectionSuspect: e.injectionSuspect }));
    const parsed = parseModelOutput(p.raw, 3);
    const base = { evidence, policy: { action: old.policyAction } as AnswerResult["policy"], rejectedEvidence: Array.from({ length: old.rejectedEvidence }) as AnswerResult["rejectedEvidence"], features: old.features, stats: old.stats, ...(old.indexFacts ? { indexFacts: old.indexFacts } : {}) };
    const q = questions.get(old.id)!;
    const mentions = specs.get(old.id)!.mentions;
    let next: AnswerRecord;
    if (!parsed.ok) {
      next = record(q, mentions, { ...base, status: "rejected", claims: [], reasons: [`malformed model output: ${parsed.reason}`], rejections: [{ code: parsed.code ?? "malformed-output", detail: parsed.reason }] });
    } else {
      const v = validateAnswer(parsed.output, new EvidenceRegistry(items, repo));
      next = record(q, mentions, { ...base, status: v.status, claims: v.claims, reasons: v.reasons, rejections: v.rejections });
    }
    const why = next.status === "rejected" ? ` [${next.rejections.map((r) => r.code).join(",")}]` : "";
    changes.push(`${old.id}: withheld (quote-too-long) -> ${next.status === "answered" ? "answered" : next.status === "rejected" ? "withheld" : next.status}${why}, ${next.claims.length} claim(s), ${next.claims.flatMap((c) => c.citations).length} citation(s)`);
    records.push(next);
  }
  const out: AnswerRun & { revalidatedFrom: string; revalidation: string } = {
    ...run,
    evidenceContract: 3,
    variant: run.variant.replace("-e2", "-e3"),
    createdAt: run.createdAt,
    records,
    revalidatedFrom: path.basename(fromFile),
    revalidation: "Deterministic re-validation under evidence contract 3 of the replies recorded for the contract-2 run named in revalidatedFrom. No model call. Only cases withheld for an over-long quote were validated again.",
  };
  writeFileSync(path.join(RESULTS, `answers.groq.run-0.3-0.5-${to}.tuning.json`), JSON.stringify(out));
  const count = (rs: AnswerRecord[], s: string) => rs.filter((r) => r.status === s).length;
  summary.push(`${from} -> ${to}: answered ${count(run.records, "answered")} -> ${count(records, "answered")}; withheld ${count(run.records, "rejected")} -> ${count(records, "rejected")}; validated again: ${changes.length}`);
  for (const c of changes) summary.push(`    ${c}`);
}
console.log(summary.join("\n"));
