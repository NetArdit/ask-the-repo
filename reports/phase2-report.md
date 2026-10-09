# Phase 2 report: retrieval validation + runtime spike

Labels: **FACT** measured here, **OBS** observation, **INF** inference, **UNC** uncertainty.
Dataset v2 (15 pinned repositories, 158 questions + 5 adversarial fixture questions). Holdout = 7 repositories (76 questions), frozen by SHA-256 lock before any retrieval ran on them. Raw runs: `reports/phase2/runs/*.json`; tables: `reports/phase2-experiments.md`.

## 1. Executive result: PARTIAL

| Area | Result |
|---|---|
| Deterministic retrieval | Improved by measured, isolated changes; 83% hit@10 on the frozen holdout (control 68%) |
| Abstention | Detects all 15 negatives but refuses 17-27% of answerable questions: usable as a soft signal, not as a gate |
| Artifact architecture | Works (cold load 0.04-0.6 s local) |
| Object storage | **Not verified against any real provider** (no credentials); only a local HTTP store |
| Next.js / Vercel | **Not verified on Vercel** (no CLI/account). Verified on a local production standalone build, after three fixes |
| Memory | Root cause found: V8 TurboFan tier-up of the WASM grammars (1.0-1.7 GB native peak). `--liftoff-only` cuts it 3.6-9x but cannot be set where NODE_OPTIONS is the only control |

## 2. Baseline vs final (positives only; control = Phase 1 retrieval on the Phase 2 dataset)

| Split | n | Run | hit@1 | hit@3 | hit@5 | hit@10 | MRR | p@5 |
|---|---|---|---|---|---|---|---|---|
| tuning | 74 | control | 36% | 47% | 55% | 64% | 0.44 | 0.16 |
| tuning | 74 | final | 53% | 68% | 78% | 84% | 0.62 | 0.27 |
| **holdout** | 69 | control | 41% | 55% | 64% | 68% | 0.49 | 0.18 |
| **holdout** | 69 | final | 49% | 72% | 81% | 83% | 0.62 | 0.27 |

- Median retrieval latency 1-2.4 ms after load. Phase 1 numbers (40 questions, 5 repos) are not comparable; control re-measured on v2: hit@10 68% on holdout, consistent with Phase 1's 68%.
- **UNC:** the holdout was looked at in aggregate once per candidate (accept/reject), so final holdout numbers are mildly optimistic. n=69, so differences of 1-2 questions (1.5-3 pts) are noise.
- Per category on holdout, hit@10 control -> final: conceptual 50->88, cross-file 57->86, endpoint 0->50 (n=2), entry-point 43->71, exact-location 67->78, imports 86->100, symbol 100->100, **config 29->29**. Regressions: tuning imports 100->86 (1 question), vite 60->50, create-react-app 80->70.

## 3. Retrieval experiments (one change at a time, each on top of the then-accepted baseline)

| # | Change | Tuning hit@10 / MRR | Holdout hit@10 / MRR | Decision |
|---|---|---|---|---|
| 1 | Demote test/example/docs x0.7 / x0.5 / x0.3 (skip when the question names tests/examples/docs) | 69 / 69->72 / 74 (control 64); MRR .51/.54/.55 | x0.3 only: 68 -> 80, MRR .49 -> .56 | **Accept x0.3** (best on tuning, grid fixed beforehand) |
| 1b | "testing" removed from test dirs (production `helper/testing` was demoted 3x) | 84 -> 84, hit@1 +2 | unchanged | Accept (found via failure analysis) |
| 2a | Index package.json/tsconfig as documents | 74 -> 81; config 13% -> 63-75% | 80 -> 81, MRR .56 -> .58; config 29 -> 43 | **Accept** |
| 2b | Declared package entry points boosted for entry-point questions (weights 0.6/1.2/2.0; intent words not searched lexically) | 81 -> 81/82/82; entry-point 50% -> 75-88% | 81 -> 83, MRR .58 -> .61; entry-point 43 -> 71; config 43 -> 29 (1 question) | **Accept weight 1.2** |
| 3 | Fold -ing/-ed verb forms | 82 -> 81 (3 up, 2 lost) | 83 -> 84, hit@3 -3 | **Reject** (noise; fixed "listening"->`listen` but broke two others) |
| 4 | Resolve workspace packages, tsconfig paths/baseUrl, `.d.ts`, directory imports | 82 -> 82 | 83 -> 84 | **Accept** for coverage; retrieval benefit not demonstrated |
| 5 | Retry failing JS files with the TSX grammar, keep the cleaner tree | 82 -> 84; react 56 -> 67, MRR .20 -> .37 | 83 -> 81 (1 question; no Flow repo in holdout) | **Accept conditionally**: benefit confirmed only on tuning |

Bugs found along the way (FACT): a minified-file heuristic dropped hand-written files that contain one long line (fixed: average line length); my first entry-boost regex contained literal backspace characters and never fired (fixed, then re-measured).

## 4. Failure analysis (tuning: 17 positives were outside the top 5 at the last full listing; one was fixed afterwards, see 1b)

| Mechanism | n | Examples | Evidence |
|---|---|---|---|
| Morphology | 4 | "listening" vs `listen`, "mounted" vs `mountEffect`, "composed" vs `compose` | verb folding fixed 1, lost 2: unresolved |
| Config intent, generic query terms | 4 | "where are package exports declared" in monorepos | right file lacks distinguishing terms; no config-intent signal |
| Large function split into 50-line windows | 3 | vite `_createServer`, `handleHMRUpdate`, react `commitRoot` | right file ranks, right window does not |
| Entry metadata missing / ambiguous | 2 | vite CLI (declared bin points at missing `dist/`), "react package" among 200 `react-*` packages | entry points to build output not in the repo |
| Competing true-ish evidence | 2 | react scheduler shim vs real fork; hono `jsx/context.ts` vs `context.ts` | short chunks win BM25 length normalisation |
| Conceptual cross-file | 1 | "which CLI command creates the dev server" | needs a link between files, not terms |
| Over-aggressive demotion (fixed) | 1 | `src/helper/testing/` | production code classified as test |

## 5. Parsing and Flow

| Language | Files | Parse errors | Fallback |
|---|---|---|---|
| TS | 3,117 | 29 (0.9%) | 0 |
| TSX | 932 | 4 (0.4%) | 0 |
| JS (all repos, after fallback) | 6,062 | 282 (4.7%; 278 are react) | 0 |

React Flow investigation (3,907 JS files): 939 have errors **before** any fix, 867 of them carry `@flow`. Errors concentrate in production source: **780 of 1,261 non-test, non-example source files (62%)** vs 6% in tests. By first error line: `import type`/`export type` 252, type annotations 174, type aliases/opaque 38, interface/declare 14, maybe types `?T` 4, generics 9, other 432 (Flow `component`/`hook` declarations, `as const`, `declare module`: sampled, not exhaustively classified). Retrying with the TSX grammar: 661 clean, 234 fewer errors, 44 no better; 939 -> 278 files still with errors; build time +30%. **INF:** Flow-specific syntax (`component`, `hook`, `{| |}`, `%checks`, `opaque type`) needs a Flow-aware grammar or preprocessing; not attempted. Stripping types is **not** judged safe without parsing.

## 6. Import resolution (all 15 repos)

| Category | Before | After (v2 resolver) |
|---|---|---|
| relative resolved | 13,321 | 13,561 (92.0% of 14,747; 96.5% excluding asset imports) |
| relative unresolved: missing | 642 | 402 (`.d.ts` targets 240 fixed; rest: build output, test fixtures, `?query` imports) |
| relative unresolved: asset / excluded file | 690 / 94 | 690 / 94 |
| workspace package | 0 of 7,993 resolved | 6,366 resolved, 76 unresolved |
| alias / baseUrl | 0 resolved | 2,387 resolved; 86 unresolved (`#types/*` from package.json `imports`, not supported) |
| bare external / node builtin | 6,320 / 2,112 | same |

## 7. Abstention (thresholds chosen on tuning, applied to holdout)

| Task | Rule | Tuning (TP/FN/FP/TN) | Holdout (TP/FN/FP/TN) |
|---|---|---|---|
| A: negatives only | idfCoverage < 0.5 | 8/0/20/54 | 7/0/12/57 |
| A | topScore < 1.1 | 7/1/16/58 | 6/1/13/56 |
| A | margin < 0.1 | 6/2/24/50 | 4/3/27/42 |
| B: also retrieval misses | idfCoverage < 0.35 | 12/12/7/51 | 12/8/5/51 |
| B | topScore < 1.3 | 17/7/16/42 | 16/4/16/40 |

TP = abstained correctly, FN = answered (harmful), FP = over-refusal. **FACT:** without abstention the false-positive rate on negatives is 100% (15/15). With coverage < 0.5, 15/15 negatives are refused while refusing 27% / 17% of answerable questions. **OBS:** most negatives use alien vocabulary (easy); the hard Vue-compiler negative sat at 0.48, caught by a hair. **INF:** coverage works as a soft signal for the model, not as a hard gate. Task B (catching retrieval misses) reaches only 72-76% balanced accuracy.
Fixtures: positives pass (login, chargeCustomer); keyword stuffing and injected README text did not hijack rank 1. The injection-style query ranks the hostile file first (coverage 0.77), so the layer that consumes evidence must treat it strictly as data.

## 8. Storage (local HTTP store only; **no real provider tested**)

| Repo | Artifact | Upload (loopback) | Fetch loopback / emulated 80 ms + 5 MB/s | Decompress+parse+derive | First query | RSS after load |
|---|---|---|---|---|---|---|
| ky | 70 KB | 35 ms | 30 / 142 ms | 12 ms | 8.7 ms | 78 MB |
| vite | 516 KB | 34 ms | 33 / 279 ms | 89 ms | 13 ms | 106 MB |
| excalidraw | 670 KB | 58 ms | 71 ms | 200 ms | 40 ms | 110 MB |
| TanStack/query | 659 KB | 151 ms (emulated) | 261 ms (emulated) | ~370 ms | 17 ms | 115 MB |
| react | 2.1 MB | 80 ms | 97 / 625 ms | 520 ms | 30 ms | 214 MB |

Failure behaviour (tested): 404 -> null, 401 -> non-retryable error with the token never echoed, truncated body -> retryable error after one retry, timeout -> retryable, traversal keys refused. **UNC:** real latency, auth (SigV4 is not implemented), consistency and cost are untested. Cold load for react is dominated by JSON parse (126 ms) and table derivation (300-420 ms), not by I/O.

## 9. Next.js / Vercel (local production standalone build; Vercel itself NOT tested)

1. **FACT:** default build fails. Turbopack reads the template path in `require.resolve(\`tree-sitter-wasms/out/tree-sitter-${name}.wasm\`)` as a glob over all ~40 grammars and fails on `Can't resolve 'env'`. Fix: `/* turbopackIgnore: true */` (build failed without it, passed with it, with or without `serverExternalPackages`).
2. **FACT:** Turbopack rewrites `import.meta.url` to a source path; file tracing cannot see the computed grammar path, so `tree-sitter-wasms` was **absent from the standalone output**. Fix: `outputFileTracingIncludes` for `/api/ingest`.
3. **FACT (silent degradation):** with the grammars missing, ingestion of ky returned HTTP 200 with 638 chunks instead of 1,007, every file as a line-window fallback. Fixed: a missing grammar now throws `GrammarLoadError` (HTTP 500 with the exact cause), tested.
4. Search route, react index, fresh server: cold request 618 ms (4 ms fetch, 172 deserialize, 414 derive, 27 search), warm 26-44 ms, RSS 210 MB. Invalid repo/SHA -> 400/404.
5. Ingest route, react, default V8 flags: 54.8 s, **peak working set 1,109 MB**, artifact 2.16 MB, no crash this run. The same react parse stage run as a plain Node process with default flags did crash with `Fatal process out of memory: Zone` (1 of 1 run); Phase 1 saw it at process exit in about 1 of 3 runs.
6. **UNC:** Vercel Hobby limits (300 s, 2 GB) are from the docs read in Phase 0; I did not deploy. Function bundle size, file-descriptor limit, cold-start under real load, and whether spawning a flagged child process is allowed there are untested.

## 10. Memory

| Check (react, fresh process each) | Peak RSS | Time |
|---|---|---|
| tarball stream only (no parse) | 88 MB | 0.6 s |
| parse, default flags | **crashed: Zone OOM** | - |
| parse, `--liftoff-only` | 147 MB | 49.8 s |
| parse, `--max-old-space-size=512`, default | 1,500 MB | 31.7 s |
| full build, default | 1,280 MB | 50.9 s |
| full build, `--liftoff-only` | 359 MB | 55.3 s |
| full build, `v8.setFlagsFromString("--liftoff-only")` at runtime | 1,477 MB | 49.2 s |

Full builds, default vs liftoff: ky 936 vs 108 MB (1.4 vs 2.5 s), vite 1,255 vs 178 (17.7 vs 4.9 s), zod 1,534 vs 172 (9.4 vs 6.0 s), excalidraw 1,552 vs 250 (25.2 vs 9.0 s), query 1,684 vs 258 (23.0 vs 11.6 s).
**Causality (evidence-based, not proven):** peak is ~0.9-1.7 GB even for a 94-file repository, is unchanged by a 512 MB heap cap, is absent when only streaming, and disappears with Liftoff-only; so the cost is native memory from V8's optimizing compile of the large WASM grammars, roughly per grammar loaded, not repository size, JS heap, streaming, indexing or serialization. `--liftoff-only` is **not allowed in NODE_OPTIONS** and the runtime flag did not help.
**Practical limits (FACT, measured):** with Liftoff-only, RSS = ~100 MB + ~0.04 MB/file (react 6.6k files 359 MB; query 3.2k files 258 MB); wall time up to 55 s for 10 MB of tarball. Without it, plan for 1.1-1.7 GB regardless of size. Enforced caps: 150 MB compressed, 600 MB unpacked, 150k entries, 1 MB per file, 120 s. Those enforce abort (Phase 1) but are not derived from memory here.

## 11. Architecture gates

| # | Question | Answer |
|---|---|---|
| 1 | Tarball still primary ingestion? | **Yes** (Phase 1: 1 request, 0 REST quota; not re-measured). Huge repos remain a risk: DefinitelyTyped reset twice mid-download |
| 2 | Trees API only metadata/fallback? | **Yes**: 74k entries = 18.9 MB JSON, truncates (nixpkgs at 73,582 entries), needs one request per blob |
| 3 | Index representation sufficient? | **Partly.** Adequate for file-level retrieval; weak for large functions (50-line windows) and has no call/relationship data |
| 4 | Object storage viable? | **UNVERIFIED** against a real provider |
| 5 | Artifact architecture viable? | **Yes** by measurement; optimise derive/parse (react 0.5 s cold) |
| 6 | Next.js/Vercel viable? | **UNVERIFIED on Vercel.** Local standalone works after three fixes; ingestion peaks at 1.1 GB, close to the 2 GB limit |
| 7 | Tree-sitter WASM viable in the runtime? | **Locally yes, with the fixes above.** Not confirmed on Vercel |
| 8 | TS/TSX parsing sufficient? | **Yes** (0.4-0.9% files with errors; none fell back) |
| 9 | Actual JS/Flow limitation? | Flow-typed source: 62% of react production files failed to parse cleanly before the TSX fallback; 278 files in the repository still have errors after it |
| 10 | Deterministic retrieval good enough to add an LLM? | **Conditionally.** 83% of answerable holdout questions have evidence in the top 10; 17% do not, and negatives always return evidence. Acceptable only for an evidence-bounded prototype with citation validation and an abstention signal, measured end to end |
| 11 | Abstention viable? | **Partly**: catches 15/15 negatives at 17-27% over-refusal |
| 12 | Embeddings justified? | **No.** Remaining failures are morphology, config intent, chunking, entry metadata: lexically addressable. No conceptual-recall gap was demonstrated (holdout conceptual hit@10 88%) |
| 13 | Blocking retrieval failures | Large-function chunk dilution; config-intent queries (holdout config 29%); entry points that point at missing build output; hit@1 only 49% |
| 14 | Phase 3 must solve | See section 12 |

## 12. Blockers for Phase 3

1. Real object-store test (Cloudflare R2 / Vercel Blob / S3 API) with auth, and a real Vercel deployment test: both need your accounts.
2. Run ingestion where `--liftoff-only` can be set (separate Node process or host), or accept 1.1-1.7 GB peaks; decide with measurements on the real platform.
3. Chunking at function granularity for large functions, config-intent handling, hit@1.
4. Grounded answering: citation validation, prompt-injection handling at the model boundary, answer-level evaluation, and using coverage as a soft abstention signal.
5. Flow-aware parsing decision.
6. Cold-load cost (derive tables 0.3-0.4 s for react).

## 13. Files changed

New: `src/benchmark/{dataset,cache,validate-dataset,experiment,experiments,exp-cli,exp-report,fixtures,abstention,flow-analysis,memory-experiment,storage-spike,store-server,process-memory,diff-runs}.ts`, `src/benchmark/dataset/v2/*`, `src/benchmark/accepted.json`, `src/index/{from-tarball,http-store}.ts`, `src/retrieve/{file-class,defaults}.ts`, `src/server/{runtime,validate}.ts`, `src/app/api/{search,ingest}/route.ts`, 9 test files. Changed: `src/index/{build,types,tokenize}.ts`, `src/ingest/{filter,tarball}.ts`, `src/parse/{extract,languages}.ts`, `src/retrieve/{search,query,loaded-index}.ts`, `src/github/client.ts`, `next.config.ts`. Removed: the Phase 1 CLI/report/pipeline/acquire-compare/questions (results kept in `reports/phase1-*`).

## 14. Verification (this session)

`tsc --noEmit` clean, `eslint . --max-warnings 0` clean, `vitest run`: **159 passed, 15 files**, `next build` succeeds. Commands (run from the repo root; `--liftoff-only` avoids the native OOM):

```
node --liftoff-only --import tsx src/benchmark/exp-cli.ts prepare     # cache pinned tarballs
node --liftoff-only --import tsx src/benchmark/exp-cli.ts validate    # check expected paths and absent terms
node --liftoff-only --import tsx src/benchmark/exp-cli.ts run accepted tuning,holdout
node --import tsx src/benchmark/exp-cli.ts report control accepted
node --import tsx src/benchmark/exp-cli.ts failures accepted          # tuning only
node --import tsx src/benchmark/exp-cli.ts abstain accepted
```
