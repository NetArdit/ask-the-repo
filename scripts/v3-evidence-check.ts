/**
 * Zero-model-call check for the benchmark version 3 evidence changes (reports/route2-benchmark-v3-design.md). For every tuning
 * case it runs the real pipeline twice, as version 2 and with the chosen changes switched on, against a stand-in provider that
 * answers nothing, and reports what evidence the model would have been given and how large the prompt would have been.
 *
 *   npx tsx scripts/v3-evidence-check.ts                                    the --evidence=v3 run configuration, with prompt E
 *   npx tsx scripts/v3-evidence-check.ts [definitions] [importers] [entries]   chosen changes only, prompt unchanged
 *
 * It reads the tuning questions, the cached tuning indexes and tarballs. It opens no holdout file, calls no model and no network,
 * and writes nothing.
 */
import path from "node:path";
import { answerQuestion, type AnswerDeps } from "../src/answer/answer";
import { DEFAULT_POLICY } from "../src/answer/defaults";
import type { EntryFact } from "../src/answer/entries";
import type { ImporterFact } from "../src/answer/importers";
import type { ModelProvider, ModelRequest } from "../src/answer/provider";
import { MapSource } from "../src/answer/source";
import { V3_EVIDENCE } from "../src/benchmark/answer-eval";
import { CACHE_ROOT, ensureTarball, openCachedTarball } from "../src/benchmark/cache";
import { loadAnswerSpecs, loadQuestions, loadRepos } from "../src/benchmark/dataset";
import { indexConfigKey } from "../src/benchmark/experiment";
import { resolveSpec } from "../src/benchmark/experiments";
import { parseRepoRef } from "../src/github/repo-ref";
import { deserializeIndex } from "../src/index/serialize";
import { LocalFsStore } from "../src/index/store";
import { DEFAULT_LIMITS, ingestTarGz } from "../src/ingest/tarball";
import { LoadedIndex } from "../src/retrieve/loaded-index";

const KNOWN = ["definitions", "importers", "entries"];
// No argument: exactly what a run with --evidence=v3 switches on, read from the same constant the runner uses, with prompt E.
const asRun = process.argv.slice(2).length === 0;
const wantedChanges = asRun ? Object.keys(V3_EVIDENCE).map((k) => ({ importerEvidence: "importers", entryEvidence: "entries" })[k]!) : process.argv.slice(2);
for (const c of wantedChanges) if (!KNOWN.includes(c)) throw new Error(`unknown change "${c}"; expected any of: ${KNOWN.join(", ")}`);
const switches: Partial<AnswerDeps> = asRun
  ? { ...V3_EVIDENCE, promptVariant: "E" }
  : {
      ...(wantedChanges.includes("definitions") ? { definitionEvidence: { maxBlocks: 2 } } : {}),
      ...(wantedChanges.includes("importers") ? { importerEvidence: V3_EVIDENCE.importerEvidence } : {}),
      ...(wantedChanges.includes("entries") ? { entryEvidence: V3_EVIDENCE.entryEvidence } : {}),
    };

/** Pattern 1: the definitions the Gate 5 audit found missing, as located by scripts/evidence-coverage.ts. */
const NEEDED_DEFINITIONS: Record<string, { what: string; file: string; start: number; end: number }[]> = {
  "ky-1": [
    { what: "#calculateRetryDelay", file: "source/core/Ky.ts", start: 567, end: 642 },
    { what: "calculateRetryTimingDelay", file: "source/core/retry-timing.ts", start: 151, end: 173 },
  ],
  "commerce-1": [{ what: "revalidate", file: "lib/shopify/index.ts", start: 506, end: 543 }],
  "commerce-3": [
    { what: "useCart", file: "components/cart/cart-context.tsx", start: 207, end: 238 },
    { what: "addToCart", file: "lib/shopify/index.ts", start: 228, end: 240 },
  ],
  "react-6": [{ what: "completeRoot (encloses the commit call)", file: "packages/react-reconciler/src/ReactFiberWorkLoop.js", start: 3511, end: 3723 }],
  "koa-5": [{ what: "respond", file: "lib/application.js", start: 283, end: 352 }],
};
/** Pattern 2: the owner's reference list of importers for the questions that ask who imports something. */
const REFERENCE_IMPORTERS: Record<string, string[]> = {
  "ky-6": ["source/core/Ky.ts", "source/utils/type-guards.ts", "source/index.ts"],
  "commerce-8": ["components/cart/actions.ts", "app/layout.tsx"],
  "zustand-4": ["src/react/shallow.ts", "src/shallow.ts"],
  "koa-3": ["lib/application.js", "lib/request.js", "lib/response.js"],
};

/** Pattern 3: the file the owner's reference names as the entry point, for the entry-point questions the model is asked. */
const REFERENCE_ENTRY: Record<string, string> = {
  "express-2": "index.js",
  "react-4": "packages/react/index.js",
};
const entries = { cases: 0, facts: 0, mainMatches: 0, declarationShown: 0 };

const spec = resolveSpec("accepted");
const store = new LocalFsStore(path.join(CACHE_ROOT, "index", indexConfigKey(spec.index)));
const repos = new Map(loadRepos().filter((r) => r.split === "tuning").map((r) => [r.repo, r]));
const questions = new Map(loadQuestions("tuning").map((q) => [q.id, q]));
const cache = new Map<string, { index: LoadedIndex; source: MapSource }>();

async function load(repo: string) {
  const hit = cache.get(repo);
  if (hit) return hit;
  const meta = repos.get(repo);
  if (!meta) throw new Error(`${repo} is not a tuning repository`);
  const ref = parseRepoRef(repo);
  const bytes = await store.get({ ...ref, sha: meta.sha });
  if (!bytes) throw new Error(`no cached index for ${repo}; this script does not build one`);
  const files = new Map<string, string>();
  await ingestTarGz(openCachedTarball(await ensureTarball(ref, meta.sha)), DEFAULT_LIMITS, (f) => void files.set(f.path, f.content.toString("utf8")), { includeConfig: true });
  const entry = { index: new LoadedIndex(deserializeIndex(bytes).artifact), source: new MapSource(files) };
  cache.clear(); // one repository in memory at a time: the larger ones are hundreds of MB of source
  cache.set(repo, entry);
  return entry;
}

class Recorder implements ModelProvider {
  readonly name = "stand-in";
  last: ModelRequest | null = null;
  async complete(request: ModelRequest): Promise<string> {
    this.last = request;
    return '{"status":"insufficient_evidence","missing":"stand-in"}';
  }
}

type Block = { id: string; path: string; startLine: number; endLine: number };
const coversDefinition = (ev: Block[], n: { file: string; start: number; end: number }) => ev.some((e) => e.path === n.file && e.startLine <= Math.min(n.end, n.start + 39) && e.endLine >= n.start);

let called = 0;
let changed = 0;
let added = 0;
let primaryChanged = 0;
let facts = 0;
const tokens: { off: number; on: number }[] = [];
const defs = { off: 0, on: 0, all: 0 };
const imps = { cases: 0, exact: 0, referenceCovered: 0, shownOff: 0, shownOn: 0, referenceFiles: 0 };
const specs = loadAnswerSpecs("tuning").sort((a, b) => questions.get(a.id)!.repo.localeCompare(questions.get(b.id)!.repo));
console.log(`Changes switched on: ${wantedChanges.join(", ")}${asRun ? " (the --evidence=v3 run configuration, with prompt E; the version 2 column uses prompt A)" : ""}\n`);
for (const s of specs) {
  const q = questions.get(s.id)!;
  const meta = repos.get(q.repo)!;
  const { index, source } = await load(q.repo);
  const run = async (extra: Partial<AnswerDeps>) => {
    const provider = new Recorder();
    const out = await answerQuestion({ index, repo: { ...parseRepoRef(q.repo), sha: meta.sha }, source, provider, searchOptions: spec.search, policy: { ...DEFAULT_POLICY, insufficientBelow: 0.3, cautionBelow: 0.5 }, ...extra }, q.question);
    const req = provider.last;
    return { out, user: req?.user ?? "", promptTokens: req ? Math.ceil((req.system.length + req.user.length) / 4) : 0 };
  };
  const off = await run({});
  const on = await run(switches);
  if (!off.out.stats.modelCalled) continue; // refused by the retrieval policy; no evidence is assembled either way
  called += 1;
  const n = off.out.evidence.length;
  const samePrimary = JSON.stringify(on.out.evidence.slice(0, n)) === JSON.stringify(off.out.evidence);
  if (!samePrimary) primaryChanged += 1;
  const extraBlocks = on.out.evidence.slice(n);
  if (extraBlocks.length > 0) changed += 1;
  added += extraBlocks.length;
  tokens.push({ off: off.promptTokens, on: on.promptTokens });
  const lines = [`${s.id}: ${n} block(s) -> ${on.out.evidence.length}; prompt ~${off.promptTokens} -> ~${on.promptTokens} tokens${samePrimary ? "" : "  !! retrieved blocks differ"}`];
  for (const e of extraBlocks) lines.push(`    + ${e.id} ${e.path} L${e.startLine}-${e.endLine}`);
  for (const note of on.user.split("\n").filter((l) => /^@@[0-9a-f]+ INDEX /.test(l))) lines.push(`    note: ${note.replace(/^@@[0-9a-f]+ INDEX /, "")}`);
  for (const need of NEEDED_DEFINITIONS[s.id] ?? []) {
    const a = coversDefinition(off.out.evidence, need);
    const b = coversDefinition(on.out.evidence, need);
    defs.all += 1;
    defs.off += a ? 1 : 0;
    defs.on += b ? 1 : 0;
    lines.push(`    needed definition ${need.what} (${need.file} L${need.start}): before ${a ? "shown" : "absent"}, after ${b ? "shown" : "absent"}`);
  }
  const entryFact = on.out.indexFacts?.find((f): f is EntryFact => f.kind === "entries");
  const expectedEntry = REFERENCE_ENTRY[s.id];
  if (entryFact) entries.facts += 1;
  if (expectedEntry) {
    entries.cases += 1;
    const main = entryFact?.entries[0]?.path ?? null;
    if (main === expectedEntry) entries.mainMatches += 1;
    const manifestShown = (ev: Block[]) => (entryFact?.manifest ? ev.some((e) => e.path === entryFact.manifest) : false);
    const declShown = on.user.split("\n").some((l) => /^@@[0-9a-f]+ INDEX entry points of package/.test(l) && l.includes("the declaring lines are shown in evidence as"));
    if (declShown) entries.declarationShown += 1;
    lines.push(`    entry: index fact ${entryFact ? `main-first entry ${main}, ${entryFact.entries.length} declared, manifest ${entryFact.manifest ?? "not indexed"}` : "ABSENT"}; reference expects ${expectedEntry}; a block of the manifest in evidence before: ${manifestShown(off.out.evidence) ? "yes" : "no"}; declaring lines in evidence after: ${declShown ? "yes" : "no"}`);
  } else if (entryFact) {
    lines.push(`    (entry fact also produced here: ${entryFact.pkg}, main-first entry ${entryFact.entries[0]?.path})`);
  }
  const fact = on.out.indexFacts?.find((f): f is ImporterFact => f.kind === "importers");
  if (fact) facts += 1;
  const reference = REFERENCE_IMPORTERS[s.id];
  if (reference) {
    imps.cases += 1;
    imps.referenceFiles += reference.length;
    const listed = fact ? fact.files.map((f) => f.path) : [];
    const sourceListed = fact ? fact.files.filter((f) => f.source).map((f) => f.path) : [];
    const missing = reference.filter((r) => !listed.includes(r));
    if (missing.length === 0 && fact) imps.referenceCovered += 1;
    if (fact && [...sourceListed].sort().join("|") === [...reference].sort().join("|")) imps.exact += 1;
    const shownIn = (ev: Block[]) => reference.filter((r) => ev.some((e) => e.path === r)).length;
    imps.shownOff += shownIn(off.out.evidence);
    imps.shownOn += shownIn(on.out.evidence);
    lines.push(`    importers: index fact ${fact ? `lists ${listed.length} (${sourceListed.length} source)` : "ABSENT (the question was not recognised or its target not resolved)"}; reference lists ${reference.length}; reference files missing from the fact: ${missing.length ? missing.join(", ") : "none"}; reference files with a block in evidence: before ${shownIn(off.out.evidence)}, after ${shownIn(on.out.evidence)}`);
  } else if (fact) {
    lines.push(`    !! an importer fact was produced for a question the reference does not treat as an importer question: ${fact.target}, ${fact.files.length} file(s)`);
  }
  if (extraBlocks.length > 0 || lines.length > 1 || !samePrimary) console.log(lines.join("\n"));
}
const max = (k: "off" | "on") => Math.max(...tokens.map((t) => t[k]));
const median = (k: "off" | "on") => [...tokens.map((t) => t[k])].sort((a, b) => a - b)[Math.floor(tokens.length / 2)];
console.log(`\nCases where the model would be called: ${called} of ${specs.length}`);
console.log(`Cases given at least one added block: ${changed}; blocks added in total: ${added}`);
console.log(`Cases whose retrieved blocks changed: ${primaryChanged} (must be 0)`);
console.log(`Needed definitions shown: before ${defs.off} of ${defs.all}, after ${defs.on} of ${defs.all}`);
console.log(`Importer questions (${imps.cases}): fact covers every reference file in ${imps.referenceCovered}; source importers equal the reference exactly in ${imps.exact}; reference files with a block in evidence: before ${imps.shownOff} of ${imps.referenceFiles}, after ${imps.shownOn} of ${imps.referenceFiles}`);
console.log(`Importer facts produced in total: ${facts}`);
console.log(`Entry-point questions with a reference (${entries.cases}): the fact's main entry equals the reference in ${entries.mainMatches}; manifest declaring lines shown in evidence in ${entries.declarationShown}. Entry facts produced in total: ${entries.facts}`);
console.log(`Prompt size, estimated at four characters per token: median ${median("off")} -> ${median("on")}, largest ${max("off")} -> ${max("on")}`);
console.log("No model was called and nothing was written.");
