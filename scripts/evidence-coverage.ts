/**
 * Read-only measurement for the Route 2 design (reports/route2-benchmark-v3-design.md): for the tuning cases behind the claims
 * that the Gate 5 audit traced to missing evidence, does the cached index already hold the missing piece as data?
 *
 *   npx tsx scripts/evidence-coverage.ts
 *
 * It reads the tuning repositories' cached indexes (the "accepted" index configuration) and nothing else: no model call, no
 * network, no holdout question, no write. It changes no retrieval, evidence, prompt, dataset, evaluator or result. What each
 * case needs is taken from reports/gate5-evidence-gap-audit.md and written out below by hand, so it can be checked against it.
 */
import path from "node:path";
import { CACHE_ROOT } from "../src/benchmark/cache";
import { loadRepos } from "../src/benchmark/dataset";
import { indexConfigKey } from "../src/benchmark/experiment";
import { resolveSpec } from "../src/benchmark/experiments";
import { parseRepoRef } from "../src/github/repo-ref";
import { deserializeIndex } from "../src/index/serialize";
import { LocalFsStore } from "../src/index/store";
import { ENTRY_KIND_CODES, IMPORT_KIND_CODES, SYMBOL_KIND_CODES } from "../src/index/types";
import { LoadedIndex } from "../src/retrieve/loaded-index";

type Need =
  /** Pattern 1: the definition of a named symbol, optionally in a given file. */
  | { kind: "definition"; name: string; file?: string }
  /** Pattern 1: the symbol that encloses a line (the function a cited call sits in). */
  | { kind: "enclosing"; file: string; line: number }
  /** Pattern 2: every file that imports a name, or that imports a given module file. `reference` is the owner's list. */
  | { kind: "importers"; name?: string; moduleFile?: string; reference: string[] }
  /** Pattern 3: a declared package entry point. */
  | { kind: "entry"; pkg: string; expectFile: string }
  /** Something the index tables cannot answer; recorded so the totals stay honest. */
  | { kind: "not-in-tables"; why: string };

const CASES: { id: string; repo: string; pattern: 1 | 2 | 3; claims: string; needs: Need[] }[] = [
  { id: "ky-1", repo: "sindresorhus/ky", pattern: 1, claims: "ky-1/A/1, A/2, B/1, C/1", needs: [{ kind: "definition", name: "#calculateRetryDelay" }, { kind: "definition", name: "calculateRetryTimingDelay" }] },
  { id: "commerce-1", repo: "vercel/commerce", pattern: 1, claims: "commerce-1/A/1, B/1", needs: [{ kind: "definition", name: "revalidate", file: "lib/shopify/index.ts" }] },
  { id: "commerce-3", repo: "vercel/commerce", pattern: 1, claims: "commerce-3/B/1, C/1", needs: [{ kind: "definition", name: "useCart" }, { kind: "definition", name: "addToCart", file: "lib/shopify/index.ts" }] },
  { id: "react-6", repo: "facebook/react", pattern: 1, claims: "react-6/A/1, B/1, C/1", needs: [{ kind: "enclosing", file: "packages/react-reconciler/src/ReactFiberWorkLoop.js", line: 3712 }] },
  { id: "koa-5", repo: "koajs/koa", pattern: 1, claims: "koa-5/A/3, B/2, C/2, C/4", needs: [{ kind: "definition", name: "respond", file: "lib/application.js" }, { kind: "definition", name: "onerror", file: "lib/context.js" }, { kind: "definition", name: "compose" }] },
  { id: "ky-6", repo: "sindresorhus/ky", pattern: 2, claims: "ky-6/A/1", needs: [{ kind: "importers", name: "HTTPError", reference: ["source/core/Ky.ts", "source/utils/type-guards.ts", "source/index.ts"] }] },
  { id: "commerce-8", repo: "vercel/commerce", pattern: 2, claims: "commerce-8/A/1, B/1", needs: [{ kind: "importers", name: "getCart", reference: ["components/cart/actions.ts", "app/layout.tsx"] }] },
  { id: "vite-6", repo: "vitejs/vite", pattern: 2, claims: "vite-6/A/1, B/1", needs: [{ kind: "not-in-tables", why: "the question asks which files implement CSS processing; that is not an import relation, so no index table lists them" }] },
  { id: "zustand-4", repo: "pmndrs/zustand", pattern: 2, claims: "zustand-4/A/1", needs: [{ kind: "importers", moduleFile: "src/vanilla/shallow.ts", reference: ["src/react/shallow.ts", "src/shallow.ts"] }] },
  { id: "koa-3", repo: "koajs/koa", pattern: 2, claims: "koa-3/A/1, B/1", needs: [{ kind: "importers", moduleFile: "lib/only.js", reference: ["lib/application.js", "lib/request.js", "lib/response.js"] }] },
  { id: "express-2", repo: "expressjs/express", pattern: 3, claims: "express-2/A/1", needs: [{ kind: "entry", pkg: "express", expectFile: "index.js" }] },
  { id: "react-4", repo: "facebook/react", pattern: 3, claims: "react-4/A/1, B/1", needs: [{ kind: "entry", pkg: "react", expectFile: "packages/react/index.js" }] },
];

const tuning = new Map(loadRepos().filter((r) => r.split === "tuning").map((r) => [r.repo, r]));
const store = new LocalFsStore(path.join(CACHE_ROOT, "index", indexConfigKey(resolveSpec("accepted").index)));
const loaded = new Map<string, LoadedIndex>();
async function indexOf(repo: string): Promise<LoadedIndex> {
  const hit = loaded.get(repo);
  if (hit) return hit;
  const meta = tuning.get(repo);
  if (!meta) throw new Error(`${repo} is not a tuning repository`);
  const bytes = await store.get({ ...parseRepoRef(repo), sha: meta.sha });
  if (!bytes) throw new Error(`no cached index for ${repo}; this script does not build one`);
  const index = new LoadedIndex(deserializeIndex(bytes).artifact);
  loaded.set(repo, index);
  return index;
}

function check(index: LoadedIndex, need: Need): { ok: boolean; text: string } {
  const a = index.artifact;
  const pathOf = (i: number) => a.files[i]![0];
  if (need.kind === "not-in-tables") return { ok: false, text: `not answerable from the index tables: ${need.why}` };
  if (need.kind === "definition") {
    const bare = need.name.replace(/^#/, "");
    const rows = a.symbols.filter((s) => (s[1] === need.name || s[1] === bare || s[2].endsWith(`.${bare}`) || s[2].endsWith(need.name)) && (!need.file || pathOf(s[0]) === need.file));
    if (rows.length === 0) return { ok: false, text: `definition of ${need.name}${need.file ? ` in ${need.file}` : ""}: NOT in the symbol table` };
    return { ok: true, text: `definition of ${need.name}: ${rows.slice(0, 3).map((s) => `${pathOf(s[0])} L${s[4]}-${s[5]} (${SYMBOL_KIND_CODES[s[3]]}, ${s[5] - s[4] + 1} lines)`).join("; ")}${rows.length > 3 ? `; +${rows.length - 3} more` : ""}` };
  }
  if (need.kind === "enclosing") {
    const fileIdx = a.files.findIndex((f) => f[0] === need.file);
    const rows = a.symbols.filter((s) => s[0] === fileIdx && s[4] <= need.line && s[5] >= need.line).sort((x, y) => x[5] - x[4] - (y[5] - y[4]));
    if (rows.length === 0) return { ok: false, text: `symbol enclosing ${need.file} L${need.line}: NOT in the symbol table` };
    const s = rows[0]!;
    return { ok: true, text: `symbol enclosing L${need.line}: ${s[2] || s[1]} L${s[4]}-${s[5]} (${SYMBOL_KIND_CODES[s[3]]}, ${s[5] - s[4] + 1} lines)` };
  }
  if (need.kind === "importers") {
    const target = need.moduleFile ? a.files.findIndex((f) => f[0] === need.moduleFile) : -1;
    if (need.moduleFile && target < 0) return { ok: false, text: `module ${need.moduleFile} is not an indexed file` };
    const rows = a.imports.filter((imp) => (need.moduleFile ? imp[3] === target : imp[5].includes(need.name!)));
    const found = [...new Set(rows.map((imp) => pathOf(imp[0])))].sort();
    const missing = need.reference.filter((r) => !found.includes(r));
    const extra = found.filter((f) => !need.reference.includes(f));
    const kinds = [...new Set(rows.map((imp) => IMPORT_KIND_CODES[imp[2]]))].join("/");
    const label = need.moduleFile ? `importers of ${need.moduleFile}` : `importers of the name ${need.name}`;
    return {
      ok: missing.length === 0,
      text: `${label}: index lists ${found.length} file(s) (${kinds || "none"}); owner's reference lists ${need.reference.length}; reference files missing from the index list: ${missing.length ? missing.join(", ") : "none"}; index-only files: ${extra.length ? `${extra.slice(0, 6).join(", ")}${extra.length > 6 ? `, +${extra.length - 6} more` : ""}` : "none"}`,
    };
  }
  const rows = a.entries.filter((e) => e[2] === need.pkg);
  if (rows.length === 0) return { ok: false, text: `declared entry of package ${need.pkg}: NOT in the entry table (${a.entries.length} entries in this index)` };
  const files = [...new Set(rows.map((e) => `${pathOf(e[0])} (${ENTRY_KIND_CODES[e[1]]})`))];
  return { ok: rows.some((e) => pathOf(e[0]) === need.expectFile), text: `declared entries of ${need.pkg}: ${files.join(", ")}; reference expects ${need.expectFile}` };
}

const totals = new Map<number, { needs: number; ok: number; cases: number; casesOk: number }>();
for (const c of CASES) {
  const index = await indexOf(c.repo);
  const results = c.needs.map((n) => check(index, n));
  const t = totals.get(c.pattern) ?? { needs: 0, ok: 0, cases: 0, casesOk: 0 };
  t.needs += results.length;
  t.ok += results.filter((r) => r.ok).length;
  t.cases += 1;
  t.casesOk += results.every((r) => r.ok) ? 1 : 0;
  totals.set(c.pattern, t);
  console.log(`\n${c.id} (pattern ${c.pattern}; claims ${c.claims})`);
  for (const r of results) console.log(`  ${r.ok ? "IN INDEX " : "MISSING  "} ${r.text}`);
}
console.log("\nTotals");
let needs = 0;
let ok = 0;
let cases = 0;
let casesOk = 0;
for (const [p, t] of [...totals].sort()) {
  console.log(`  pattern ${p}: ${t.ok} of ${t.needs} needed pieces are in the index; ${t.casesOk} of ${t.cases} cases have all of theirs`);
  needs += t.needs;
  ok += t.ok;
  cases += t.cases;
  casesOk += t.casesOk;
}
console.log(`  overall: ${ok} of ${needs} needed pieces; ${casesOk} of ${cases} cases`);
console.log(`\nInputs read: cached indexes of ${loaded.size} tuning repositories under ${path.join(CACHE_ROOT, "index")}. Nothing was written.`);
