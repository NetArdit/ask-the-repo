/**
 * Builds the package a human reviewer needs for Phase 4B gate 5: for every tuning case and prompt variant, the question, the
 * model's reply, each claim with the evidence it gave, the exact lines that evidence points to, and what the structural
 * validator made of it. The reviewer decides whether the lines support each claim; nothing here decides that.
 *
 *   npx tsx scripts/review-package.ts
 *
 * It reads the private run records (reports/private/phase4b/*.raw.jsonl) and the locally cached repository tarballs, and makes
 * no network or model call. The output quotes third-party source, so it is written under reports/private/review/, which git
 * ignores. It never marks a case reviewed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrivateRecord } from "../src/benchmark/answer-eval";
import { ensureTarball, openCachedTarball } from "../src/benchmark/cache";
import { loadAnswerSpecs, loadQuestions, loadRepos } from "../src/benchmark/dataset";
import { parseRepoRef } from "../src/github/repo-ref";
import { splitLines } from "../src/index/hash";
import { DEFAULT_LIMITS, ingestTarGz } from "../src/ingest/tarball";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = path.join(ROOT, "reports", "private", "phase4b");
const OUT = path.join(ROOT, "reports", "private", "review");
const MAX_SPAN_LINES = 90;

const LABEL_NOTICE = [
  "> **OWNER-SUPPLIED REFERENCE LABELS — NOT INDEPENDENT GROUND TRUTH.**",
  "> The \"reference\" shown for each case (expected files, lines and terms, and whether the repository can answer the question)",
  "> was drafted by the project owner and has not been independently reviewed. Use it as a hint about what the question was",
  "> meant to find, never as the answer key.",
].join("\n");

const questions = new Map(loadQuestions("tuning").map((q) => [q.id, q]));
const specs = loadAnswerSpecs("tuning");
const repos = new Map(loadRepos().filter((r) => r.split === "tuning").map((r) => [r.repo, r]));

const sources = new Map<string, Map<string, string[]>>();
async function linesOf(repo: string, sha: string, file: string): Promise<string[] | null> {
  let files = sources.get(repo);
  if (!files) {
    files = new Map();
    const tarball = await ensureTarball(parseRepoRef(repo), sha);
    await ingestTarGz(openCachedTarball(tarball), DEFAULT_LIMITS, (f) => void files!.set(f.path, splitLines(f.content.toString("utf8"))), { includeConfig: true });
    sources.set(repo, files);
  }
  return files.get(file) ?? null;
}

function fence(text: string): string {
  // A fence longer than any run of backticks in the text, so repository content cannot close it early.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

function readRecords(file: string): PrivateRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as PrivateRecord);
}

async function renderCase(rec: PrivateRecord): Promise<{ text: string; claims: number }> {
  const q = questions.get(rec.id)!;
  const spec = specs.find((s) => s.id === rec.id);
  const out: string[] = [];
  out.push(`## ${rec.id} — ${rec.repo} @ ${rec.sha.slice(0, 7)}`, "");
  out.push(`**Question:** ${q.question}`, "");
  out.push(`**Category:** ${q.category}`, "");
  const expected = q.expected.length === 0 ? "none: the owner marked this question as one the repository cannot answer" : q.expected.map((e) => `\`${e.path}\`${e.lines ? ` L${e.lines[0]}–${e.lines[1]}` : ""}`).join("; ");
  out.push(`**Owner-supplied reference (not ground truth):** expected evidence: ${expected}. Expected terms in the answer: ${spec?.mentions.length ? spec.mentions.map((m) => `"${m}"`).join(", ") : "none"}.`, "");

  const called = rec.stats.modelCalled;
  const outcome =
    rec.status === "answered"
      ? "ANSWERED (passed structural validation)"
      : rec.status === "rejected"
        ? "WITHHELD (failed structural validation)"
        : rec.status === "insufficient_evidence"
          ? called
            ? "NOT ENOUGH EVIDENCE (the model declined)"
            : "NOT ENOUGH EVIDENCE (the retrieval policy refused; the model was not asked)"
          : rec.status.toUpperCase();
  out.push(`**Outcome:** ${outcome}`, "");
  for (const fact of rec.indexFacts ?? []) {
    // What the application said on its own authority, from the index. Shown so the reviewer sees what the reader would see; it is not a claim to judge.
    if (fact.kind === "importers") {
      out.push(`**Stated by the application (from the index, not a model claim):** ${fact.files.length} file(s) import \`${fact.target}\`: ${fact.files.map((f) => `\`${f.path}\` L${f.line}${f.source ? "" : " (test, example or docs)"}`).join("; ")}.`, "");
    } else {
      out.push(`**Stated by the application (from the index, not a model claim):** entry points of package \`${fact.pkg}\`: ${fact.entries.map((e) => `${e.entryKind} → \`${e.path}\``).join("; ")}. Manifest: ${fact.manifest ? `\`${fact.manifest}\`` : "not indexed"}.`, "");
    }
  }
  if (rec.rejections.length > 0) {
    out.push("**Structural rejection reasons:**", "");
    for (const r of rec.rejections) out.push(`- \`${r.code}\`${r.claim ? ` claim ${r.claim}` : ""}${r.citation ? ` citation ${r.citation}` : ""}${r.detail ? ` (${r.detail})` : ""}`);
    out.push("");
  }

  const offered = new Map(rec.offered.map((e) => [e.id, e]));
  for (const [i, claim] of rec.claims.entries()) {
    out.push(`### ${rec.id} claim ${i + 1}`, "", `> ${claim.text.replace(/\n/g, " ")}`, "");
    out.push(`Structural status: \`${claim.status}\``, "");
    for (const c of claim.citations) {
      const ev = offered.get(c.id);
      out.push(`**${c.id}**${ev ? ` — \`${ev.path}\` L${ev.startLine}–${ev.endLine}${ev.injectionSuspect ? " (flagged: reads like instructions)" : ""}` : " — not an evidence id that was offered"}`, "");
      out.push(`- citation id valid: ${c.verdict.valid ? "yes" : `no (${"reason" in c.verdict ? c.verdict.reason : ""})`}`);
      out.push(`- quote found verbatim in ${c.id}: ${c.quoteVerbatim ? "yes" : "no"}`);
      out.push("- quote given by the model:", "", fence(c.quote), "");
      if (ev) {
        const lines = await linesOf(rec.repo, rec.sha, ev.path);
        if (lines) {
          const span = lines.slice(ev.startLine - 1, ev.endLine);
          const shown = span.slice(0, MAX_SPAN_LINES).map((l, k) => `${String(ev.startLine + k).padStart(5)}| ${l}`);
          out.push(`- lines ${c.id} points to${span.length > MAX_SPAN_LINES ? ` (first ${MAX_SPAN_LINES} of ${span.length})` : ""}:`, "", fence(shown.join("\n")), "");
        } else out.push("- lines: not available from the local tarball cache", "");
      }
    }
    out.push("**Reviewer verdict (tick one):** [ ] SUPPORTED  [ ] PARTIAL  [ ] UNSUPPORTED  [ ] CONTRADICTED", "", "Reviewer note:", "");
  }
  if (rec.claims.length === 0) out.push("_No claims to review for this case._", "");

  out.push("<details><summary>Raw model reply</summary>", "", rec.raw === null ? "_The model was not called for this case._" : fence(rec.raw), "", "</details>", "", "---", "");
  return { text: out.join("\n"), claims: rec.claims.length };
}

mkdirSync(OUT, { recursive: true });
// The package is built from the replies as they were recorded, which is under contract 2 for every run so far. Runs on version 3
// evidence carry "-v3" after the contract number and get a file and a label of their own.
const RECORDED_CONTRACT = 2;
const files = existsSync(PRIVATE) ? readdirSync(PRIVATE).filter((f) => f.endsWith(`-e${RECORDED_CONTRACT}.raw.jsonl`) || f.endsWith(`-e${RECORDED_CONTRACT}-v3.raw.jsonl`)) : [];
const labelRows = ["case_id,variant,claim,structural_status,verdict,reviewer,note"];
const summary: string[] = [];
const reviewFiles: [string, string][] = [];
const variantsSeen: string[] = [];
for (const file of files.sort()) {
  const all = readRecords(path.join(PRIVATE, file));
  const records = specs.map((s) => all.find((r) => r.id === s.id)).filter((r): r is PrivateRecord => r !== undefined);
  if (records.length === 0) continue;
  const onV3 = records[0]!.evidenceVersion === 3;
  const variant = `${records[0]!.promptVariant}${onV3 ? "-v3" : ""}`;
  const complete = records.length === specs.length;
  const body: string[] = [];
  let claims = 0;
  for (const rec of records) {
    const repo = repos.get(rec.repo);
    if (!repo || repo.sha !== rec.sha) throw new Error(`${rec.id}: record is not for the pinned tuning commit`);
    const rendered = await renderCase(rec);
    body.push(rendered.text);
    claims += rendered.claims;
    rec.claims.forEach((c, i) => labelRows.push(`${rec.id},${variant},${i + 1},${c.status},,,`));
  }
  const head = [
    `# Phase 4B human review — prompt variant ${variant}`,
    "",
    `**Gate 5 status: NOT STARTED.** Reviewer: ______________  Date: ______________`,
    "",
    LABEL_NOTICE,
    "",
    `- Run: \`${records[0]!.variant}\`, model \`${records[0]!.model ?? records[0]!.provider}\`, evidence contract ${records[0]!.evidenceContract}, tuning split only.`,
    ...(onV3 ? ["- **Version 3 evidence on the version 2 tuning questions.** The model was also given import lines and manifest lines taken from the index, and the application stated some facts itself (shown per case as \"Stated by the application\"). Those facts are not the model's claims and need no verdict. Not comparable case for case with the version 2 runs."] : []),
    `- Provenance: ${variant === "A" ? "preserved model outputs, deterministically re-validated after the evaluator correction (two records changed rejection code only). This is NOT a fresh generation run." : "an actual model run under the final evaluator."} One run of this variant; no holdout calls; no winner is established.`,
    `- Cases in this file: ${records.length} of ${specs.length}${complete ? "" : " — **this run is incomplete; the missing cases have not been run yet**"}. Claims to review: ${claims}.`,
    "- \"Structural\" results say only that an evidence id is real and that a quote occurs in the block it names. They say nothing about whether the lines support the claim. That judgement is yours.",
    "- For each claim, read the quoted passage and the lines it points to, then tick one verdict: SUPPORTED (the lines establish the claim), PARTIAL (they establish part of it), UNSUPPORTED (they do not establish it), CONTRADICTED (they show the opposite).",
    "- Withheld replies are included so you can judge what the validator rejected as well as what it let through.",
    "",
    "---",
    "",
  ];
  reviewFiles.push([path.join(OUT, `review-${variant}.md`), head.join("\n") + body.join("\n")]);
  variantsSeen.push(variant);
  summary.push(`${variant}: ${records.length}/${specs.length} cases, ${claims} claims${complete ? "" : " (incomplete run)"}`);
}

// A reviewer's verdicts live in labels-template.csv. Regenerating the package must never lose one: what was recorded for a row
// is carried over as it stands, and if a row that carries a verdict, a reviewer or a note would no longer exist, nothing is written.
const LABELS = path.join(OUT, "labels-template.csv");
const rowKey = (line: string) => line.split(",").slice(0, 3).join(",");
const recorded = new Map<string, string>();
if (existsSync(LABELS)) {
  for (const line of readFileSync(LABELS, "utf8").split(/\r?\n/).slice(1)) {
    const filled = line.split(",").slice(4).join(",");
    if (filled.replace(/,/g, "").trim() !== "") recorded.set(rowKey(line), filled);
  }
}
const newKeys = new Set(labelRows.slice(1).map(rowKey));
const orphaned = [...recorded.keys()].filter((k) => !newKeys.has(k));
if (orphaned.length > 0) {
  throw new Error(`Refusing to regenerate: ${orphaned.length} reviewed row(s) would be lost (${orphaned.slice(0, 5).join("; ")}). Nothing was written.`);
}
const mergedRows = labelRows.map((row, i) => (i > 0 && recorded.has(rowKey(row)) ? `${row.split(",").slice(0, 4).join(",")},${recorded.get(rowKey(row))}` : row));
for (const [file, text] of reviewFiles) writeFileSync(file, text);
writeFileSync(LABELS, `${mergedRows.join("\n")}\n`);
const fileList = variantsSeen.map((v) => `\`review-${v}.md\``).join(", ");
writeFileSync(
  path.join(OUT, "README.md"),
  [
    "# Phase 4B human-review package",
    "",
    `**Gate 5 status: NOT PASSED.** Rows of \`labels-template.csv\` with something recorded by a reviewer: ${recorded.size} of ${labelRows.length - 1}.`,
    "",
    LABEL_NOTICE,
    "",
    `- ${fileList}: one file per prompt variant, with every case, claim, quote and cited passage.`,
    "- `labels-template.csv`: one row per claim. Fill in `verdict` (SUPPORTED, PARTIAL, UNSUPPORTED or CONTRADICTED), `reviewer` and `note`. Regenerating this package keeps what is recorded there.",
    "- This folder quotes third-party source code and is not part of the public repository.",
    "- Comparability: every variant is scored by the same final evaluator, but A uses preserved outputs re-validated after the correction, while the others are actual runs under it. D is not a single-factor variant and is to be compared with C. One run per variant, tuning split only, zero holdout calls, no winner established.",
    `- Structural validity (a real evidence id and a quote found in its block) is not semantic support. ${recorded.size === 0 ? "No verdict is recorded here yet" : `${recorded.size} row(s) carry a recorded verdict, reviewer or note`}, and nothing says the application is production-ready.`,
    "",
    "Contents when generated:",
    "",
    ...(summary.length ? summary.map((s) => `- ${s}`) : ["- no run records were found"]),
    "",
  ].join("\n"),
);
console.log(JSON.stringify({ out: path.relative(ROOT, OUT), variants: summary, claimRows: labelRows.length - 1 }));
