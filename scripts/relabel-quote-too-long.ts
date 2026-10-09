/**
 * One-off, deterministic: records written before the validator named an over-long quote carry `malformed-output` for it.
 * For each such record this re-parses the stored private raw reply with the current parser and, only if that now yields
 * `quote-too-long`, rewrites the record's rejection and reason. Nothing else is touched and no model is called.
 *   npx tsx scripts/relabel-quote-too-long.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseModelOutput } from "../src/answer/validate";

const root = path.resolve(import.meta.dirname, "..");
const ckDir = path.join(root, "reports/phase3/checkpoints");
const privDir = path.join(root, "reports/private/phase4b");
const LONG = "an evidence quote is longer than 400 characters";

interface Rec { id: string; status: string; reasons: string[]; rejections: { code: string; detail?: string }[]; [k: string]: unknown }

function fix(rec: Rec, raw: string | undefined): boolean {
  if (rec.status !== "rejected" || !rec.rejections?.some((r) => r.code === "malformed-output") || raw === undefined) return false;
  const p = parseModelOutput(raw);
  if (p.ok || p.code !== "quote-too-long") return false;
  rec.reasons = [`malformed model output: ${p.reason}`];
  rec.rejections = [{ code: "quote-too-long", detail: p.reason }];
  return true;
}

let changed = 0;
for (const f of readdirSync(ckDir).filter((n) => n.endsWith("-e2.jsonl"))) {
  const rawFile = path.join(privDir, f.replace(/\.jsonl$/, ".raw.jsonl"));
  if (!existsSync(rawFile)) continue;
  const raws = new Map(readFileSync(rawFile, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l) as { id: string; raw: string }; return [r.id, r.raw] as const; }));
  for (const [file, rawOf] of [[path.join(ckDir, f), raws], [rawFile, raws]] as const) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
    let n = 0;
    for (const r of lines) if (fix(r, rawOf.get(r.id))) { n++; console.log(`${path.basename(file)}: ${r.id} -> quote-too-long`); }
    if (n) { writeFileSync(file, lines.map((r) => JSON.stringify(r)).join("\n") + "\n"); changed += n; }
  }
}
// Complete result artifacts hold the same records.
for (const f of readdirSync(path.join(root, "reports/phase3")).filter((n) => /-e2\.tuning\.json$/.test(n))) {
  const file = path.join(root, "reports/phase3", f);
  const j = JSON.parse(readFileSync(file, "utf8")) as { records?: Rec[]; results?: Rec[] };
  const list = j.records ?? j.results ?? [];
  const raws = new Map<string, string>();
  for (const rf of readdirSync(privDir).filter((n) => n.endsWith("-e2.raw.jsonl")))
    for (const l of readFileSync(path.join(privDir, rf), "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as { id: string; raw: string; variant: string }; if (f.includes(r.variant.replace("run-", ""))) raws.set(r.id, r.raw); }
  let n = 0;
  for (const r of list) if (fix(r, raws.get(r.id))) { n++; console.log(`${f}: ${r.id} -> quote-too-long`); }
  if (n) { writeFileSync(file, JSON.stringify(j, null, 2) + "\n"); changed += n; }
}
console.log(`relabelled ${changed} record(s); expected LONG=${LONG}`);
