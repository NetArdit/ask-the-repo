# Audit: retrieval, parsing, index, and the evidence-quality model

Scope: read-only system audit. Central question: **where could a technically valid citation still be the wrong evidence?**
Method: reading `src/retrieve/**`, `src/index/**`, `src/ingest/**`, `src/parse/**`, `src/server/runtime.ts`, `src/answer/{evidence,validate,answer,policy}.ts`; reading `reports/`; and light read-only `tsx` probes (scripts kept in the session scratchpad, not in the repo). Probes rebuilt the ky, express and commerce indexes in memory from the cached tarballs in `%TEMP%/ask-the-repo-cache` (no network, no model calls, nothing written to the repo or to `.cache`). I also read `reports/private/phase4b/*.raw.jsonl` for counts only (quote lengths, evidence classes); no source text is reproduced here.
No file under `src/`, tests, prompts, dataset or other reports was changed. No commits.

Labels: **MEASURED** (a number exists in the repo's reports or was produced by my probes), **VERIFIED(read)** (confirmed by reading the code), **INFERRED** (the mechanism is in the code but no run shows the effect). Priority: P0 correctness/security/data-integrity blocker, P1 release-critical, P2 high-value hardening, P3 useful, P4 defer.
"Cmp." says whether acting on the finding would change benchmark numbers (Phase 2 retrieval metrics, Phase 3/4B answer tables) and so needs a new baseline or an `EVIDENCE_CONTRACT` bump.

## 0. Bottom line

- **No P0 found.** Nothing I read lets a forged, cross-repo or cross-commit citation through, and the index is deterministic apart from `createdAt` (MEASURED, below).
- The structural chain (id -> span re-fetched at the pinned SHA -> chunk fingerprint -> verbatim quote in that one block) is sound for what it claims. The gap is everything the chain cannot see: **a citation can be valid, verbatim and still point at a comment, a test, an adjacent window of the right function, a file the index silently dropped, or the opposite of what was asked** (negation is stripped before retrieval).
- Three measured facts change how the existing numbers should be read:
  1. **79% of holdout expected-evidence items (85 of 107) and 55% of tuning items (58 of 106) are file-level labels** (no `lines`), and `overlaps()` counts any chunk of that file as a hit (`src/benchmark/evaluate.ts:6-11`). So hit@k (holdout hit@10 83%, hit@1 49%) is mostly "right file", not "right lines". MEASURED from `src/benchmark/dataset/v2/questions.*.json`.
  2. Retrieval's abstention signal saturates on one-term and few-term questions: a question whose only term appears once in a *comment* in the repository gets coverage 1.00 and top-1 evidence (commerce, "retry", `lib/shopify/index.ts:508`, a comment). MEASURED by probe.
  3. Retrieval is negation-blind end to end: "does not use retry", "uses retry" and "retry" return identical rankings (MEASURED by probe on ky and commerce). `not`/`no` are removed by the index stopword list, so this cannot be fixed on the query side alone.

Finding index: Q = evaluation quality, R = retrieval, P = parsing/ingest, I = index/runtime, E = evidence/validation.

| Id | Pri | Area | One line | Cmp.? |
|---|---|---|---|---|
| Q-01 | P1 | measurement | Retrieval relevance is file-level for most labels; hit@k overstates chunk-level relevance | reporting only |
| Q-02 | P1 | measurement | Support, completeness, contradiction have no independent measurement; "reference-supported" is overlap, not support | reporting only |
| R-01 | P2 | retrieval | Comment, string and licence text indexed exactly like code; coverage saturates on single-term hits | YES |
| R-02 | P2 | retrieval | Negation and intent words are discarded; opposite questions rank identically | YES |
| R-03 | P2 | retrieval | Code stopwords (`default`, `export`, `import`, `class`, `new`, `catch`, `throw`, `delete`) and numbers are dropped from queries | YES |
| R-04 | P2 | retrieval | Scoring constants are hand-set and never swept; import expansion not ablated on v2 | YES if changed |
| R-05 | P3 | retrieval | Large functions split in 50-line windows; symbol-to-chunk uses start line only | YES |
| R-06 | P3 | retrieval | Import-neighbour chunks get a bonus independent of match strength | YES |
| R-07 | P3 | retrieval | Demotion is path-only, x0.3 on the fused score, switched off by loose words (`spec`, `guide`, `sample`) | YES |
| R-08 | P3 | retrieval | Tie-breaking is implicit (Map insertion order); no ties seen in 51 probe runs | may perturb |
| R-09 | P3 | retrieval | Non-English, short, long questions: safe failure for non-Latin, noisy for Latin-script foreign text | message: no; unicode: YES |
| P-01 | P2 | ingest | Unsupported languages and skipped files are dropped silently and not recorded in the artifact or shown per repository | no |
| P-02 | P2 | ingest | Wall-clock parse timeout makes the artifact load-dependent (1.76 s measured against a 2 s limit) | no |
| P-03 | P3 | ingest | Vendored-directory rule matches any path segment (`build`, `out`, `dist`, `vendor`, `coverage`) | YES |
| P-04 | P3 | parse | One syntax error can erase every symbol in a file (measured) | YES |
| P-05 | P3 | ingest | Minified and generated heuristics can drop hand-written files | YES if changed |
| P-06 | P3 | parse | `countLines` and `splitLines` disagree by one on files ending in a newline; CR-only files are one line | no |
| P-07 | P3 | parse | Symbol extraction covers top-level declarations and class members only | YES |
| I-01 | P2 | index | A version-mismatched or corrupt artifact is a permanent 500; it is never treated as a miss and rebuilt | no |
| I-02 | P2 | index | Index identity is `owner/repo@sha` only; tokenizer, filter and chunker changes do not change identity | YES on change |
| I-03 | P2 | index | Artifact `key` is never compared with the requested key; no artifact checksum | no |
| I-04 | P3 | index | `BoundedStore` evicts by write time, not by use; the in-memory cache is the only true LRU | no |
| I-05 | P3 | index | Fingerprint check can fail wholesale where tarball and contents-API bytes differ (INFERRED) | no |
| I-06 | P4 | index | `createdAt` makes serialized bytes non-reproducible; everything else is identical (MEASURED) | no |
| I-07 | P4 | index | Postings decode cache is unbounded within one loaded index; decode runs on the event loop | no |
| E-01 | P2 | evidence | The first evidence block is exempt from the character budget | no |
| E-02 | P2 | evidence | Quote rule accepts any 3-character verbatim substring, including comments and licence text | YES (contract) |
| E-03 | P3 | evidence | Budget omissions and rejected candidates are silent to the reader | no |
| E-04 | P3 | evidence | `fileLineCount` is one larger than the real line count | no |

---

## 1. Measured versus inferred: what the repository actually knows

### 1.1 Evidence-quality dimensions

| Dimension | Measured anywhere? | Where | What the number is, and its limits |
|---|---|---|---|
| Retrieval relevance | **MEASURED, with a caveat (Q-01)** | `reports/phase2-report.md` s2; `phase2-experiments.md`; `phase1-report.md` ablation | Holdout (n=69 positives) hit@1/3/5/10 = 49/72/81/83%, MRR 0.62, control 41/55/64/68%. Tuning n=74: 53/68/78/84%. Labels are owner-drafted, not independently reviewed; holdout was seen in aggregate once per candidate (Phase 2 calls the result mildly optimistic); 79% of holdout expected items are file-level. Differences of 1-2 questions are noise (Phase 2 s2). |
| Citation structural validity | **MEASURED** | `phase3-report.md` s3; `phase4b-tuning-abc.md` | Scripted: 5,000-citation fuzz against an independent oracle, 0 disagreements; 8 attack classes blocked 5/5. Real model, tuning, one run each: valid/total A 35/35, B 29/29, C 25/25. Says nothing about relevance. |
| Quote provenance | **MEASURED** | same | Quote must occur in the one block it names. Real runs: `quote-not-in-citation` A 1, B 3, C 0; `quote-too-long` A 2, B 3, C 3 (a length limit rejects otherwise correct replies). Not measured: whether quotes are informative (E-02). |
| Claim-to-evidence semantic support | **NOT MEASURED** | `phase4-report.md`, `phase3-report.md` s1 | The only "support" numbers ("claims supported by the reference" A 0.857, B 0.941, C 0.900; "evidence precision") are overlap with the owner's expected spans. 28 support labels exist, all `reviewed: false`; judge agreement never run; one assistant reading of one real claim (`phase4b-release-validation.md`). |
| Answer completeness | **NOT MEASURED (proxy only)** | `answer-eval.ts` | "Correct" = cites expected evidence AND states expected keywords (A 15, B 12, C 14 of 24). Keyword presence, not completeness. Retrieval item-recall@10 exists (Phase 1: 56%) but is retrieval, not answer. |
| Abstention correctness | **MEASURED, thin** | `phase2-report.md` s7; `phase3-report.md` s5; `phase4b-tuning-abc.md` | Retrieval-level: coverage<0.5 catches 15/15 negatives at 17-27% over-refusal. Real model, tuning: unanswerable refused A 7/8, B 8/8, C 8/8; answerable refused 4-5 of 24. 15 negatives total, most with alien vocabulary (Phase 2 admits this); one hard negative missed on tuning. |
| Contradiction detection | **NOT MEASURED** | `phase4b-release-validation.md` | SA4 is one synthetic case, one run, first scored by a negation-blind oracle that was later corrected by reading the replies. 4 CONTRADICTED draft labels exist, unreviewed. |
| Instruction-injection resistance | **MEASURED structurally; real model only narrowly** | `phase3-report.md` s6; `phase4b-adversarial-plan.md` | Scripted: hostile text never in the instruction channel (0 of 35 prompts); an obedient scripted attacker reaches the reader 5/5 (warning on 4). Real model: SA5-SA8 passed in two runs of variant A on a synthetic repository. No real hostile repository; no B/C result (C had 7 unexplained provider errors). |

### 1.2 Retrieval-pipeline facts I could verify

| Fact | Status | Source |
|---|---|---|
| BM25 K1=1.2, B=0.75, SYMBOL 0.6, PATH 0.5, IMPORT_DECAY 0.25, seed chunks 3, neighbours 20, path files 10, per-file cap 3 are constants; none appears in `experiments.ts`, `accepted.json` or any report as a swept parameter | VERIFIED(read) + grep | `src/retrieve/search.ts:6-14` |
| Parameters that were tuned: class weights (0.7/0.5/0.3 grid, 0.3 accepted), entry weight (0.6/1.2/2.0, 1.2 accepted), stem mode (plural kept, verb folding rejected), config indexing, flow fallback, import resolution | MEASURED | `phase2-experiments.md`, `phase2-report.md` s3 |
| Component ablation exists only in Phase 1 on 40 questions: bm25 43% -> +symbols 60% -> +paths 65% -> +import expansion 68% hit@10 | MEASURED (n=40, superseded dataset) | `phase1-report.md` |
| Chunk shape (ky / express / commerce): 1007 / 695 / 145 chunks; 89% / 77% / 69% are 16-50 lines; 0 gaps and 0 overlaps within files; 9 / 2 / 4 symbols span more than one chunk | MEASURED (probe) | rebuilt indexes |
| Rebuilding the same tarball twice gives identical artifacts once `createdAt` is cleared (ky, express, commerce) | MEASURED (probe) | rebuilt indexes |
| Ties among the top 10 fused scores: 0 in 51 query x repo runs | MEASURED (probe) | rebuilt indexes |

---

## 2. Findings

### Measurement

**Q-01 | P1 | Retrieval relevance is mostly file-level, so hit@k overstates chunk relevance**
- FACT: `overlaps()` returns true for any chunk of the expected file when the expected item has no `lines` (`src/benchmark/evaluate.ts:6-11`).
- EVIDENCE (MEASURED): expected items without `lines`: holdout 85 of 107, tuning 58 of 106 (`src/benchmark/dataset/v2/questions.holdout.json`, `questions.tuning.json`). The Phase 2 failure analysis found 3 of 17 tuning misses where "right file ranks, right window does not", visible only on line-labelled items.
- IMPACT: the reported 83% hit@10 and 49% hit@1 answer "did the right file appear". The product cites chunks; a valid, verbatim citation to the wrong window of the right file counts as a retrieval hit and as "cites the expected evidence" in the answer tables (`overlaps` is reused).
- RECOMMENDATION: report file-level and line-level hit rates separately (computable now on the 22 holdout / 48 tuning items that carry lines; state n). Do not relabel the frozen dataset.
- Cmp.: reporting only. Adding line ranges to v2 would break `freeze.lock.json`; use a new dataset version.

**Q-02 | P1 | Support, completeness and contradiction are unmeasured; two metrics sound like support but are overlap**
- FACT: "claims supported by the reference" and "evidence precision" are overlap of a cited span with the owner's expected span (`phase3-report.md` s4: "Claim reference-support (a claim's own citation overlaps expected)"). "Correct" additionally needs expected keywords.
- EVIDENCE: all 28 support labels are `reviewed: false` (`phase4-report.md`); no judge run; `phase4b-tuning-abc.md` itself says "Structural validity is not support."
- IMPACT: a claim can cite the expected file, overlap the expected lines and still overstate, omit or invert what the lines say. Nothing in the repo would show it. This is the "valid citation, wrong evidence" gap and it is measured by nothing but one assistant reading of one claim.
- RECOMMENDATION: section 4. Append "(overlap with owner labels, not semantic support)" wherever these figures are quoted. VERIFIED(read) for the definition; the absence of a measurement is MEASURED by its absence in every report.
- Cmp.: reporting only.

### Retrieval

**R-01 | P2 | Comments, strings and licence headers are indexed like code; coverage saturates on single-term hits**
- FACT: `termFrequencies()` tokenises every identifier-shaped word in the chunk text, comments and strings included (`src/index/tokenize.ts:72-78`, called from `src/index/build.ts:171`). Nothing distinguishes a comment hit from a code hit in BM25, symbol or coverage scoring. A file's first chunk includes its licence header (chunks are contiguous from line 1, `mergeUnits`, `src/parse/chunk.ts:524-549`).
- EVIDENCE (MEASURED, probe): on vercel/commerce the question "retry" returns 1 evidence block, `lib/shopify/index.ts`, `idfCoverage` 1.00. The only occurrence in that file is a comment (`// otherwise it will continue to retry the request.`, line 508, confirmed with `tar | grep`). Coverage is the idf-weighted share of query terms found in the top-3 chunks (`src/retrieve/search.ts:247-262`), so with one term it is 0 or 1 and `DEFAULT_POLICY` (`insufficientBelow 0.3`) cannot refuse it. Multi-term dilution is erratic: "what does the retry option do ..." scored 0.06 on commerce (refused) and 0.41 on ky (caution) driven by ordinary words.
- IMPACT: the model is shown a comment as the only evidence and may answer "the code retries requests" with a valid citation and a verbatim quote. The validator and the coverage policy both pass it.
- RECOMMENDATION: (a) index comment text in a separate low-weight field or flag chunks whose matched terms occur only in comments (tree-sitter yields `comment` nodes); (b) add a code-term coverage feature and evaluate it as an abstention signal on the existing negatives before adopting; (c) at minimum record `queryTermCount` next to coverage so a single-term 1.00 is not read as strong.
- Cmp.: **YES.** Run as a labelled experiment against the frozen `accepted` baseline.

**R-02 | P2 | Negation and intent words are discarded before and after tokenisation**
- FACT: the index-side `ENGLISH_STOPWORDS` (`tokenize.ts:8-11`) contains `not`, `no`, `but`, `all`, `any`, `when`, `can`, `out`, `into`; `keep()` applies it to queries as well (`identifierTerms`, `tokenize.ts:58-69`). `QUESTION_WORDS` (`query.ts:4-12`) additionally drops `get`, `use`, `call`, `file`, `code`, `support`, `handle`, `show`, `work`.
- EVIDENCE (MEASURED, probe): on ky and commerce "does not use retry", "uses retry", "retry", "Retry", "RETRY" give identical top-1 and scores (ky `source/core/retry-timing.ts` 1.81; commerce `lib/shopify/index.ts` 1.00). `analyzeQuestion("What happens when the user is not logged in?")` -> `["user","logged"]`. The real-model SA2/SA3/SA4 replies that the first oracle mis-scored were all negated answers.
- IMPACT: "does X not ...", "when is Y skipped", "which paths never ..." retrieve the same evidence as the affirmative form; retrieval cannot prefer evidence showing an absence, so the model sees affirmative code and must infer the opposite.
- RECOMMENDATION: do not try to retrieve on negation. Detect it (`not|never|no|without|unless`) as a question feature, log it, and make it an evaluation stratum ("polarity-sensitive"). Pass it to the prompt/judge as a hint only after measurement.
- Cmp.: feature logging no; changing stopwords **YES**.

**R-03 | P2 | Code stopwords and numbers vanish from queries**
- FACT: `CODE_STOPWORDS` (`tokenize.ts:1-6`) includes `default`, `export`, `import`, `class`, `type`, `interface`, `new`, `delete`, `static`, `async`, `await`, `try`, `catch`, `throw`, `return`, `case`, `switch`, `public`, `private`. `TOKEN_RE` requires a leading letter (`query.ts:21`), so `404`, `429` are never terms. Index and query agree, so these words are unsearchable lexically (path and symbol lanes can still help).
- EVIDENCE (MEASURED, probe): "Where is the default export defined?" -> 0 terms (refused); "How does the DELETE handler work?" -> `["handler"]`; "How does HTTP 429 get handled?" -> `["http"]`; "Which class handles new connections?" -> `["connection"]`; "What is the default value of the retry limit?" drops `default`. `café` -> `caf`.
- IMPACT: questions about defaults, exports, HTTP verbs, status codes and error handling lose their discriminating word, in every repository.
- RECOMMENDATION: keep the stopwords at index time but exempt them on the query side when they are the only discriminating term, or add phrase handling (`default export`, `status code`). Measure on a targeted stratum first.
- Cmp.: **YES.**

**R-04 | P2 | Scoring constants are hand-set and never swept; import-expansion value on dataset v2 is unknown**
- EVIDENCE: see 1.2. K1, B, SYMBOL_WEIGHT, PATH_WEIGHT, IMPORT_DECAY, IMPORT_SEED_CHUNKS, MAX_NEIGHBOURS, MAX_PER_FILE do not occur in `experiments.ts` or in `accepted.json`; `DEFAULT_SEARCH_OPTIONS` (`src/retrieve/defaults.ts`) holds only class weights and entry settings. K1=1.2 / B=0.75 are the textbook defaults (INFERRED provenance; no document says otherwise). The only ablation of symbols/paths/imports is Phase 1 on 40 questions.
- IMPACT: Phase 2 calls the configuration the one that "survived experiments"; for the lexical core that is not true. Failure analysis already shows short chunks winning on BM25 length normalisation (react scheduler shim, hono `context.ts`), and B, which governs that, was never varied.
- RECOMMENDATION: one-variable sweep on tuning only (B in {0.3,0.5,0.75,0.9}, K1 in {0.9,1.2,1.6,2.0}, IMPORT_DECAY off/0.25/0.5), accept on tuning, apply once to holdout, exactly as the class-weight experiment did. Record the provenance of every constant in `accepted.json`.
- Cmp.: an experiment; if accepted it is a new baseline, and the report must name the old one.

**R-05 | P3 | Large functions are windowed; symbol hits map to the start chunk only**
- FACT: oversized top-level statements are split into 50-line windows (`splitOversized`, `chunk.ts:511-517`); classes at member boundaries (`extract.ts:246-266`). `chunkAtLine(sym[0], sym[4])` returns the chunk containing the symbol's start line (`loaded-index.ts:378-386`, used at `search.ts:144`).
- EVIDENCE (MEASURED, probe): symbols spanning more than one chunk: ky 9 of 328, express 2 of 595, commerce 4 of 188. Phase 2: `_createServer`, `handleHMRUpdate`, `commitRoot` (right file, wrong window; 3 of 17 tuning misses).
- IMPACT: the cited window can start mid-function with no signature; a quote from the tail of a function is valid yet a claim about "what the function does" rests on a fragment. The symbol boost never reaches later windows.
- RECOMMENDATION: boost every chunk a matched symbol overlaps (decayed) and put the enclosing symbol name in the evidence header shown to the model. Measure with a line-level hit rate (Q-01).
- Cmp.: **YES.**

**R-06 | P3 | Import neighbours receive a bonus unrelated to match strength**
- FACT: neighbour files of the top-3 chunks (imports and importers, up to 20) contribute their best lexical chunk if it has any BM25 weight, scored `fused + 0.25 * parentScore` (`search.ts:195-223`). The bonus ignores the neighbour's own score and is not class-demoted.
- EVIDENCE: INFERRED (no v2 ablation, R-04). Phase 1: +3 points hit@10 on n=40.
- IMPACT: a file that merely imports, or is imported by, a strong hit and shares one common term can displace a genuine lower-ranked hit in the top 10. Valid, topical, wrong.
- RECOMMENDATION: scale the bonus by `min(1, neighbour.bm25 / maxBm25)` or require two matched terms; evaluate with R-04.
- Cmp.: **YES.**

**R-07 | P3 | Test/docs demotion is path-only and gated by loose words**
- FACT: classes come from path segments (`file-class.ts:3-17`; `scripts`, `bench`, `e2e`, `fixtures`, `template-*` count as example/test). The 0.3 weight multiplies the whole fused score including exact-symbol evidence (`search.ts:187-190`). Demotion is skipped when the question matches `tests?|specs?|examples?|demos?|samples?|docs?|documentation|readme|guide|tutorial|template` (`file-class.ts:21`).
- EVIDENCE: demotion is the largest measured retrieval gain (holdout hit@10 68 -> 80, MRR .49 -> .56). Express class split (MEASURED, probe): 91 test + 45 example + 2 docs + 7 source + 1 config of 146 files. In the offered evidence of the 21 model-called tuning questions of variant A (MEASURED from private raw records): 153 source and 12 non-source blocks; all 30 cited blocks were source. Keyword-stuffed `docs/cite-me.md` still reached the top 8 in the semantic-attack fixture (SA1/SA7, `phase4-report.md`).
- IMPACT: any question containing `spec`, `guide`, `sample` or `template` (for example "OpenAPI spec") turns demotion off; a library whose real code lives under `scripts/` or `bench/` is demoted; in test-heavy repositories tests dominate the candidate pool.
- RECOMMENDATION: narrow the trigger to intent phrases ("in the tests", "example of", "docs for") and log `demotionApplied` so evaluation can stratify.
- Cmp.: **YES.**

**R-08 | P3 | Ranking determinism relies on implicit order**
- FACT: ranking is `Array.sort` by score only over `candidates` (a `Map` filled in query-term order, then posting order, then symbol and path lanes), re-sorted after import expansion (`search.ts:191-192, 220-222`). Sort is stable, so ties follow insertion order. The path lane's `chunkIds.sort` (`search.ts:170`) behaves the same way.
- EVIDENCE: MEASURED 0 ties in the top 10 across 51 probe runs; an identical question and index reproduce the result. INFERRED: ties become likely for very short questions and equal-length duplicated chunks, and would then depend on question word order.
- RECOMMENDATION: add a final comparator `(score desc, path asc, startLine asc)`.
- Cmp.: only exact ties can move; diff a full run (`diff-runs.ts`) before and after and report.

**R-09 | P3 | Short, long, non-English and no-overlap questions**
- MEASURED (probe): "a", "how", "404", "$" -> 0 terms and 0 evidence (safe: `decideSufficiency` refuses on empty evidence). Cyrillic and CJK questions -> 0 terms (safe). Latin-script French "où est la gestion des erreurs" -> terms `est, la, gestion, des, erreur`; 0 evidence on ky and commerce, 1 test file at coverage 0.17 on express (refused by policy at 0.3). A long English question with 6 terms scored coverage 0.41 (ky), 0.04 (express), 0.06 (commerce). INFERRED: long questions with several uncommon words are the most likely to be refused or put in "caution" even when partly answerable; the 300-character cap (`src/server/validate.ts:3`) bounds this.
- IMPACT: non-English questions fail closed, which is the right direction, but the UI should say "no searchable terms found" rather than "not enough evidence". ASCII-only tokenisation splits accented words (`café` -> `caf`) and can create false term matches.
- RECOMMENDATION: unicode-aware token regex on both sides (symmetric), or a note that retrieval is English/ASCII-identifier only.
- Cmp.: message change no; tokenisation change **YES**.

### Parsing and ingest

**P-01 | P2 | Unsupported languages and skipped files are silent**
- FACT: only `js/jsx/mjs/cjs/ts/mts/cts/tsx/md/mdx` and nine config file names are indexed (`src/ingest/filter.ts:28-49`). Everything else is dropped with a count in `IngestStats.skipped`, which is not stored in the artifact and not returned by `/api/ingest` (it returns `files`, `chunks`, `parse` only, `src/app/api/ingest/route.ts:30-39`). `RepoSummary` reports indexed languages only.
- EVIDENCE (MEASURED, probe): express skipped 68 files as unsupported-extension, ky 8 (+2 binary), commerce 5 (+2 binary, 1 lockfile). The scope is disclosed generically on the landing page and in the README (`src/app/page.tsx:25`, `README.md:123`); the latest commit added an explanation for zero-file repositories.
- IMPACT: for a repository whose main code is Python, Go, Rust or a framework dialect (`.vue`, `.svelte`, `.astro`), the few indexed JS/MD files become the evidence: answers are valid, verbatim and about the tooling or docs, not the product. "Does the repo do X?" answered "no" is an absence claim over a partial index.
- RECOMMENDATION: persist per-reason skip counts and the top skipped extensions in the artifact (optional field; version bump handled per I-01) and show "N files in unsupported languages were not indexed (for example 412 .py)" in the workspace header and beside answers when the indexed share is small.
- Cmp.: no (benchmark repositories are JS/TS).

**P-02 | P2 | The parse timeout is wall-clock, so the artifact depends on machine load**
- FACT: `parseSource` cancels when `performance.now() > deadline` (2,000 ms default, `extract.ts:218, 555-558`); a cancelled parse returns line-window fallback with reason `parse-timeout` (`extract.ts:569`). Identity is `owner/repo@sha`; whichever build ran first wins.
- EVIDENCE (MEASURED, probe): a 600 KB single-line TS file parsed in 1,763 ms against the 2,000 ms limit on this 4 GB machine. Phase 2 saw zero fallbacks on 15 repositories; same-tarball rebuilds were identical on an unloaded machine. INFERRED: on a loaded or throttled host, files near the limit flip between `ast` and `fallback`, changing chunks, symbols and imports for one SHA.
- IMPACT: two instances can hold different indexes for the same commit; a benchmark rebuilt under load is not the benchmark that was run. Nothing marks the artifact (parse-status counts are not stored).
- RECOMMENDATION: bound work by input size (bytes or node count) instead of time; store the number of timed-out files in the artifact and treat any `parse-timeout` as a build warning.
- Cmp.: no if the size bound only triggers on files that currently time out; verify with a full artifact diff.

**P-03 | P3 | Vendored-directory rule matches any path segment**
- FACT: any directory named `node_modules, vendor, vendors, third_party, third-party, dist, build, out, .next, .nuxt, coverage, .git, .yarn, .pnpm-store, bower_components, __pycache__, .turbo, .cache` excludes the file at any depth (`filter.ts:14-17, 60`).
- EVIDENCE (MEASURED, tar listings): honojs/hono top-level `build/` (release adapter, d.ts plugin, fixtures; 5 files) is excluded; vite has fixture files under `.../license/.../build/` and `playground/resolve/browser-field/out/`. No benchmark expected path is affected (the `validate` step checks that expected paths exist). INFERRED from repository layouts, not benchmarked: projects whose production source lives in a `build/` or `out/` directory (a bundler or compiler with `src/build/`) lose that source entirely.
- IMPACT: absence of evidence for a core subsystem; the model answers from neighbours.
- RECOMMENDATION: treat these names as generated output only at the repository root or beside a `package.json` without a sibling `src`; record excluded directory names in the skip statistics (P-01).
- Cmp.: **YES** (index contents change).

**P-04 | P3 | One syntax error can erase a file's symbols**
- FACT: with errors the status becomes `ast-with-errors` and extraction still walks `rootNode`, but tree-sitter recovery often wraps the remainder in an `ERROR` node, and `Extractor.run` visits top-level named children only (`extract.ts:238-244`).
- EVIDENCE (MEASURED, probe): `export function a( {\n return 1;\n}\nexport function ok(){return 2}` -> `ast-with-errors`, 0 symbols, 1 chunk; `}}}}{{{{` and a lone `<div>` the same. Prevalence: TS 0.9%, TSX 0.4%, JS 4.7% of files (278 of 282 JS error files are in react, Flow) (`phase2-report.md` s5).
- IMPACT: the symbol lane and exact-name boost vanish for such files; chunking collapses to few large units. BM25 still finds them.
- RECOMMENDATION: descend into `ERROR` nodes for declaration candidates; store the count of error files with zero symbols.
- Cmp.: **YES** (JS-heavy repositories such as react).

**P-05 | P3 | Minified and generated heuristics**
- FACT: files with an average line length over 200 characters across the first 200 KB are dropped as `minified-content`; a header (first 600 characters) matching `@generated|DO NOT EDIT|auto-?generated|This file (was|is) generated` drops the file (`filter.ts:70-83`). `.d.ts` files are not excluded.
- EVIDENCE (MEASURED, probe): 200 lines of 280 characters (a data table) -> `minified-content`; one 300 KB line -> `minified-content`. Phase 2 already fixed an earlier over-aggressive version. INFERRED: a hand-written file that says "DO NOT EDIT" in a comment is dropped.
- IMPACT: silent loss of hand-written data/config modules; large generated `.d.ts` files stay as `source`.
- RECOMMENDATION: record dropped paths per reason (P-01); consider an explicit generated-`.d.ts` rule; report the thresholds.
- Cmp.: **YES** if thresholds change.

**P-06 | P3 | Line and byte mapping**
- MEASURED (probe): LF, CRLF, BOM-prefixed, emoji-containing and U+2028-containing sources yield identical symbol and chunk line ranges. BOM and invalid UTF-8 are treated identically at index time and source-fetch time (both use `Buffer.toString("utf8")`: `from-tarball.ts:40`, `source.ts:296`), so hashes agree. A CR-only file is one line (symbols `a:1-1,b:1-1`).
- MEASURED: `countLines()` (used for `lineCount` and chunk bounds) excludes the trailing empty element; `splitLines()` (`index/hash.ts:12-14`) includes it: a 7-line file ending in `\n` gives 7 vs 8. Chunk ranges are unaffected; `fileLineCount` and the UI "lines in file" are one too large (E-04).
- IMPACT: negligible for the chain; CR-only files are rare.
- RECOMMENDATION: one line-count definition everywhere; document CR-only as unsupported.
- Cmp.: no.

**P-07 | P3 | Symbol and import extraction scope**
- FACT: symbols come from top-level statements, class members and `module.exports`/`exports.x` assignments (`extract.ts:296-343, 435-468`). Not extracted: functions nested in blocks or call arguments (for example `app.get(path, handler)`), object-literal methods, `namespace`/`declare module`, `import x = require()`. `#subpath` imports and `package.json` `imports` stay unresolved (86 in Phase 2).
- EVIDENCE: Phase 2 holdout "endpoint" hit@10 50% (n=2), entry-point 71%; relative import resolution 92% (96.5% excluding assets) (`phase2-report.md` s2, s6).
- IMPACT: no exact-symbol boost for these constructs; "where is the route for X" rests on BM25.
- RECOMMENDATION: add call-argument handler names as pseudo-symbols for framework-style routes; evaluate on a larger endpoint stratum.
- Cmp.: **YES.**

### Index and runtime

**I-01 | P2 | A version-mismatched or corrupt artifact is a permanent 500**
- FACT: `readIndex` calls `deserializeIndex` (throws `Unsupported index version N` or a brotli error) without catching (`src/server/runtime.ts:78-89`, `src/index/serialize.ts:28-36`). `/api/ingest` calls `loadCachedIndex` first (`src/app/api/ingest/route.ts:57`); the error is not a known type, so `ingestErrorResponse` logs it and returns 500 (`src/server/errors.ts:19-31`). The key is never rebuilt or overwritten. `/api/repo`, `/api/search`, `/api/answer` also 500.
- EVIDENCE (MEASURED): the local store at `%TEMP%/ask-the-repo-index-store` holds version-1 artifacts; loading one raised "Unsupported index version 1" (current `INDEX_VERSION` is 3). Tests only check that deserialization throws (`index.test.ts:95-98`).
- IMPACT: the next `INDEX_VERSION` bump (needed for I-02, P-01 and several retrieval changes) breaks every cached repository in the HTTP store until objects are deleted by hand.
- RECOMMENDATION: in `loadCachedIndex` treat unsupported-version and decode errors as `null` (miss, server log), so ingest rebuilds and overwrites; keep network and truncation errors as errors.
- Cmp.: no.

**I-02 | P2 | Index identity ignores everything but the commit**
- FACT: the store path is `owner/repo@sha.idx.br` (`src/index/store.ts:141-146`). `artifact.config` records `stemMode/includeConfig/parseVariant/resolveWorkspaceAndAliases`, but the tokenizer stopword lists, chunk sizes (`MAX_CHUNK_LINES 80`, `MIN 15`, `WINDOW 50`), the file filter and the vendored list are code constants outside the key. `search` always applies `DEFAULT_SEARCH_OPTIONS` regardless of `artifact.config`.
- EVIDENCE: VERIFIED(read). Phase 3 bumped the version once (chunk hashes); no other change class is gated.
- IMPACT: after changing any of R-01, R-03, P-03, P-05, R-05 without a version bump, old artifacts keep serving with new query code (inconsistent term spaces, for example a new query stopword list against old postings). A benchmark reusing cached artifacts would silently mix configurations.
- RECOMMENDATION: store a build fingerprint (hash of the relevant constants plus a manual `INDEX_VERSION`) in the artifact and compare at load; mismatch is a miss (I-01).
- Cmp.: none now; it makes every later retrieval change detectable.

**I-03 | P2 | The artifact's own key is not compared with the requested key; no artifact checksum**
- FACT: `readIndex(key)` caches the `LoadedIndex` under the requested key without checking `artifact.key` (`runtime.ts:78-89`). `HttpIndexStore.get` validates only `content-length` (`http-store.ts:72-76`). `summarizeIndex` reports `artifact.key`, not the requested key.
- EVIDENCE: VERIFIED(read). Existing mitigation: at answer time every span is re-fetched and fingerprint-checked (`evidence.ts:392`), so a misplaced artifact cannot yield an accepted citation; it yields `source-mismatch` and `no_evidence`. `/api/search` returns path/line/score without that check.
- IMPACT: an object-store mix-up or poisoned object gives wrong search results and a misleading summary for a key; answers fail closed. Data-integrity hardening; I could not construct an exploit.
- RECOMMENDATION: reject when `artifact.key` differs from the request (case-insensitive owner/repo, exact sha); add a SHA-256 of the artifact JSON as object metadata or trailer.
- Cmp.: no.

**I-04 | P3 | Store "LRU" is write-time FIFO**
- FACT: `BoundedStore.get` does not touch mtime; `prune` sorts by `mtimeMs` ascending and deletes the oldest until under the limit, keeping the newest file (`bounded-store.ts:191-228`). The in-memory `cache` is a true LRU of 2 (`runtime.ts:22, 61-66, 87`).
- EVIDENCE: VERIFIED(read).
- IMPACT: a frequently used older index is evicted before a once-used newer one; cost is a re-index ("never a wrong answer", per the file's own comment). Only the local-disk store is bounded; the HTTP store is not.
- RECOMMENDATION: `utimes` on a successful local `get`, or describe it as "oldest-written first".
- Cmp.: no.

**I-05 | P3 | Fingerprint check can fail wholesale where archive and contents bytes differ**
- FACT: the index is built from the `codeload` tarball (`git archive`); evidence is verified against `api.github.com/.../contents?ref=sha` raw bytes. `git archive` applies `.gitattributes` (`export-ignore`, `export-subst`, eol conversion); the contents API returns the stored blob.
- EVIDENCE: INFERRED from git semantics, not reproduced. Against the 15 benchmark repositories with tarball source "evidence items that could not be verified: 0"; 11 of 11 verified against real GitHub on one repository (`phase3-report.md` s3).
- IMPACT: a repository with `* text eol=crlf` or `$Format:...$` expansion would show `source-mismatch` on every span and answer `no_evidence`. Fails closed but confusingly.
- RECOMMENDATION: surface `rejectedEvidence` reasons to the user; add one fixture repository using `export-subst`.
- Cmp.: no.

**I-06 | P4 | Determinism**
- MEASURED (probe, two builds each of ky, express, commerce): after clearing `createdAt` the full artifact JSON is identical in all three. `createdAt` (`build.ts:392`) makes serialized bytes differ; Brotli with fixed parameters is deterministic.
- RECOMMENDATION: keep `createdAt` but exclude it from any future content hash; see P-02 for the one non-deterministic input.
- Cmp.: no.

**I-07 | P4 | Index size and memory**
- MEASURED (Phase 2/3): artifacts 70 KB (ky) to 2.29 MB brotli (react, about 9 MB decoded); cold load react 0.46-0.62 s of which derive 0.3-0.4 s; RSS after load 78-214 MB; `MAX_DECODED_INDEX_BYTES` 256 MB; at most 2 loaded indexes. Chunk hashes added 5-11%.
- VERIFIED(read): `LoadedIndex.decoded` caches decoded postings per term for the life of the index (`loaded-index.ts:312, 358-376`); bounded by vocabulary but never trimmed. Decode and derive run synchronously on the event loop (also T-06 in `audit/technical.md`).
- Cmp.: no.

### Evidence assembly and validation

**E-01 | P2 | The first evidence block is exempt from the budget**
- FACT: `if (result.totalChars + text.length > opts.budgetChars && result.items.length > 0) { omit }` (`src/answer/evidence.ts:397-400`). With no items yet, any size is accepted, and nothing caps a chunk's characters (the 80-line cap is lines, not bytes).
- EVIDENCE: INFERRED from the code. A file under 1 MB whose average line length is under 200 passes the minified filter yet can hold one very long line (the `minified-content` test averages over the first 200 KB). In all measured runs evidence stayed within budget (median 7.2-7.7k chars, max 19.6k of 24k, `phase3-report.md` s9).
- IMPACT: provider cost or context overflow (`provider_error`); the user sees an error, not a wrong answer.
- RECOMMENDATION: truncate (with a marker the quote validator understands) or reject any single block above a fixed size such as 12k characters; add a unit test with a one-line 100 KB chunk.
- Cmp.: no for normal chunks; confirm with a benchmark diff that no tuning/holdout item exceeds the cap.

**E-02 | P2 | A quote can be any 3-character verbatim passage, including a comment or licence line**
- FACT: `quoteIsVerbatim` strips `Lnn|` prefixes, collapses whitespace, requires `length >= 3` and a substring match against that item's text (`validate.ts:135-139`). Nothing checks that the quote is code, shares a term with the claim, or is not boilerplate. (Also noted as T-08 in `audit/technical.md`; this adds the measured distribution and the link to R-01.)
- EVIDENCE (MEASURED from private raw replies, counts only): 104 real quotes across the A/B/C contract-2 runs; minimum lengths 33 / 3 / 26, medians 76 / 89 / 97 characters, 1 of 104 under 25 characters. The real model has not exploited the weakness in 3 x 32 questions. The scripted `cites-irrelevant-but-valid-evidence` attacker reaches the reader 5/5 (`phase3-report.md` s6), structurally the same class.
- IMPACT: the validator cannot distinguish a quote that shows the claim from one that merely exists; with R-01 a quote from a comment passes.
- RECOMMENDATION: record per claim, as diagnostics only at first: quote length, whether the quote lies in a comment span (tree-sitter), and whether it shares a content term with the claim. Decide a minimum from the data. Do not change acceptance without bumping `EVIDENCE_CONTRACT`.
- Cmp.: **YES** if acceptance changes (contract 3; all A/B/C results become non-comparable, as at 1 -> 2). Diagnostics only: no.

**E-03 | P3 | Omissions and replacements are invisible to the reader**
- FACT: `omittedForBudget` and `rejectedEvidence` are returned in the result (`answer.ts:140` and `stats`), but no UI file renders them (grep over `src/ui` and `src/app` finds only a test fixture with `omittedForBudget: 0`). A rejected candidate (`source-mismatch`, `source-unavailable`) is replaced by the next-ranked one (`evidence.ts:372-395`).
- IMPACT: an answer built from the 8th-ranked span reads as authoritative; the dropped rank-3 span is not mentioned.
- RECOMMENDATION: show "k of n retrieved spans used; m could not be verified" and the retrieval rank of each cited span.
- Cmp.: no.

**E-04 | P3 | `fileLineCount` is one larger than the file**
- FACT/EVIDENCE: `fileLineCount: lines.length` with `lines = splitLines(text)` (`evidence.ts:98`), so a file ending in a newline reports N+1 (P-06). `range-beyond-file` (`validate.ts:119`) therefore accepts a locator for the nonexistent line N+1. Models cite ids only and `outside-evidence-range` also applies, so reachability is low.
- RECOMMENDATION: use `countLines`.
- Cmp.: no.

---

## 3. Where a technically valid citation can still be the wrong evidence

"Valid" = passes `EvidenceRegistry.check` and `quoteIsVerbatim`.

| # | Pathway | Control today | Measured? |
|---|---|---|---|
| W1 | Hit or quote is in a **comment, string or licence header** (R-01, E-02) | none | one retrieval probe; real-model rate not measured |
| W2 | Evidence is a **test, example, fixture or doc** | x0.3 fused demotion; off for 11 loose words (R-07) | retrieval gain MEASURED; real runs: 12 of 165 offered blocks non-source, 0 of 30 cited |
| W3 | **Right file, wrong window** of a split function (R-05) | none | partly (3 of 17 tuning misses); not separable in hit@k (Q-01) |
| W4 | **Competing or duplicate implementation** (shims, forks, `context.ts` vs `jsx/context.ts`) | none | Phase 2 failure analysis, 2 cases |
| W5 | **Opposite polarity**: question negated, evidence affirmative (R-02) | none | MEASURED (identical rankings); model behaviour on 3 synthetic cases only |
| W6 | **Partial index**: unsupported language or skipped vendored/generated/minified/large file, so a negative claim is made over an incomplete corpus (P-01, P-03, P-05) | generic scope disclosure; counts not stored | not measured for answers |
| W7 | **Trivial quote** (E-02) | 3-character minimum | 1 of 104 real quotes under 25 characters |
| W8 | **Import neighbour** chosen on weak overlap (R-06) | `via` flag in the result | INFERRED |
| W9 | **Hostile or instruction-bearing text** | fencing, nonce, keyword flag | scripted 5/5 reach the reader; real model 8 synthetic cases |
| W10 | **Question reinterpretation**: dropped words change the question (R-02, R-03) | none | MEASURED for examples |
| W11 | **Over- or under-claiming** relative to the quoted code | prompt rules (variant C trims partial support) | unmeasured (Q-02) |
| W12 | **Silent narrowing**: budget omissions, rejected candidates replaced by lower ranks (E-01, E-03) | stats only | not measured |
| W13 | **Stale or wrong index served** | key = sha; fingerprint at answer time; I-01 to I-03 gaps | fingerprint: 0 unverified (tarball source, 15 repos), 11/11 real GitHub on one repo |
| W14 | **Coverage saturation**: one-term question answered on one hit (R-01) | idf coverage 0.3 / 0.5 | MEASURED (commerce `retry`) |

---

## 4. Proposed evaluation matrix (not implemented)

Principles: one oracle per dimension; never reuse overlap-with-owner-labels as support; stratify; report n and label provenance; keep the frozen holdout untouched until a variant is frozen.

| Dimension | Unit | Oracle | Population needed | Metrics | Existing assets | Gap | Cmp. with prior numbers |
|---|---|---|---|---|---|---|---|
| Retrieval, file level | question | owner labels (file) | existing 158 | hit@k, MRR | all | report separately from line level | same |
| Retrieval, line level | question | line-labelled expected items | >= 100 line-labelled items (today 22 holdout, 48 tuning) | hit@k, item recall, window precision | partial | tuning-only relabelling in a new dataset version; never edit v2 | new baseline |
| Citation validity | citation | deterministic validator | every run | valid/total by rejection code | complete | none | same |
| Quote provenance | quote | verbatim check plus new diagnostics | every run | verbatim rate; length distribution; comment-only quote rate; claim-term overlap rate | verbatim only | diagnostics (E-02), comment spans | additive |
| Claim support | claim | human review (>= 2 reviewers, kappa), then a judge model calibrated to it | >= 120 claims balanced over SUPPORTED/PARTIAL/UNSUPPORTED/CONTRADICTED | per-label precision/recall, unsafe-agreement rate | 28 draft labels, judge harness | human review, larger set | new |
| Completeness | question | per-question "must-mention" fact lists (not keyword lists) | 60-100 answerable | fact recall, claim precision | keyword proxy | fact lists | replaces proxy |
| Abstention | question | negatives including hard ones (adjacent vocabulary; feature present only in an unsupported language or skipped directory) | >= 50 negatives, >= 20 hard | refusal on negatives, over-refusal on positives, per-feature ROC (coverage, topScore, margin, code-term coverage) | 15 negatives, thresholds | more and harder negatives; single-term stratum | new |
| Contradiction and polarity | question pair | paired affirmative/negated questions over one repo state | >= 40 pairs | polarity accuracy, retrieval overlap within a pair | 4 draft CONTRADICTED labels, SA2-SA4 | paired set (R-02) | new |
| Injection resistance | answer | scripted plus real-model suites on synthetic repos and one real hostile repo; oracle with negation handling (T-01 patch pending) | >= 30 attacks x 3 runs | obedience, leak, accepted-and-harmful rates | scripted suite, SA1-SA8 | more attacks, repeats, corrected oracle | new |
| Index coverage honesty | repository | known corpus composition | 15 benchmark repos plus 5 mixed-language repos | share of files indexed; share of questions whose expected file was skipped | stats not persisted | P-01 | new |
| Determinism | build | artifact equality across 3 builds, one under load | 15 repos | artifact diff = 0 modulo `createdAt` | 3 repos, manual | script it; add loaded-host run (P-02) | same |

Stratify every table by: question category; polarity; term count (1, 2-3, 4+); whether demotion was applied; language and class of the cited file; whether the cited quote is in a comment; retrieval rank of the cited span; whether any evidence was rejected or omitted.

Run order that respects the frozen methodology: (1) reporting-only changes (Q-01, Q-02 wording, diagnostics) on existing artifacts; (2) one-variable retrieval experiments on tuning under a new dataset version, so the v2 hashes in `freeze.lock.json` stay valid; (3) a contract bump only together with an E-02 acceptance change and a full A/B/C rerun; (4) holdout once, `--final`.

---

## 5. Comparability summary

| Action | Affects benchmark comparability? |
|---|---|
| Q-01 / Q-02 reporting; E-03, P-01, I-04, I-05 UI and statistics | No |
| I-01, I-03, I-06, I-07, E-01 (cap only when exceeded), E-04, P-06 | No functional change; verify with a full artifact diff |
| P-02 size-based parse bound | No if it only triggers on files that now time out; verify |
| R-08 explicit tie-break | Only exact ties can move; diff a run |
| R-01, R-02 (stopwords), R-03, R-04, R-05, R-06, R-07, P-03, P-04, P-05, P-07, unicode tokenisation | **Yes**: new retrieval baseline; compare against `accepted` on tuning, then holdout once |
| I-02 build fingerprint | No now; makes every change above detectable |
| E-02 acceptance change (minimum quote length, comment-only quotes) | **Yes**: `EVIDENCE_CONTRACT` 3; A/B/C all rerun |
| Any edit to dataset v2 labels (Q-01 line ranges) | **Yes**: breaks `freeze.lock.json`; use a new dataset version |

## 6. Limits of this audit

- No network, model call, build, test run or Vercel/object-store check was made; reported test counts were not re-run. The probes rebuilt ky, express and commerce only (vite and react were not rebuilt, to stay within 4 GB). Artifacts in `%TEMP%/ask-the-repo-index-store` are version 1 and could not be loaded, so retrieval probes used fresh in-memory builds with `DEFAULT_INDEX_CONFIG` and `DEFAULT_SEARCH_OPTIONS`.
- The probe questions are mine and few (17 questions on 3 repositories); they demonstrate mechanisms, not rates.
- Reads of `reports/private/**` were limited to counts and path classes; no third-party source text is reproduced.
- INFERRED items (R-06, I-05, the E-01 trigger, P-03 beyond the benchmark repositories, P-02 under load) have a mechanism in the code but no demonstration; treat them as hypotheses to test.
