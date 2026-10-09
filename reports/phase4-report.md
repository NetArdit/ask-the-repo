# Phase 4 report: real-model validation + support evaluation

Labels: FACT, OBSERVATION, INFERENCE, UNCERTAINTY, OPEN.

## Stop rule hit: B

The environment has **no ANTHROPIC_API_KEY, no GitHub token, no Vercel access, no object-store credentials** (checked by name only; no value was read or printed). Section 1 therefore did not run: **no real model was called, no tokens were counted, no cost was incurred, and no result in this report is a model result.** I stopped the real-model parts cleanly and built the provider-independent tooling the later steps need.

## Proven / partially proven / unproven

| Item | Status |
|---|---|
| Structural citation validity (forged ids, ranges, SHA, repo, quotes, malformed output) | **PROVEN** (Phase 3; unchanged; 296 tests) |
| Source cache behaviour: hit, miss, SHA keying, TTL, byte limit, coalescing, retry | **PROVEN locally** (14 unit tests + emulated benchmark); real provider **OPEN** |
| Source cache wired into the real route, with real GitHub as upstream | **PROVEN for one repo**: cold 1.1 s, cached 7 ms, 8 files cached on disk |
| Judge/agreement/kappa machinery works | **PROVEN on scripted inputs only** |
| Semantic-attack suite is a deterministic, reusable check | **PROVEN as tooling**; baseline result below is not a model result |
| Claim, citation, evidence, **support** chain for a real model | **UNPROVEN** |
| Human-labelled reference set | **PARTIALLY PROVEN**: 28 labelled claims exist, but labels are assistant drafts, **not yet human-reviewed** |
| Judge agreement with humans | **UNPROVEN** (needs a model and reviewed labels) |
| Prompt variants A/B/C | **UNPROVEN** (implemented and tested for structure; never run against a model) |
| Final holdout gate | **NOT RUN** (and must not run before the above) |
| Real Vercel, real object storage | **OPEN** |

## What was built

1. **Token accounting.** `ModelRequest.onUsage` receives the provider's own `input_tokens`/`output_tokens`; `AnswerResult.stats` carries them, or `null` when the provider reports none. Tested with a stubbed API. Cost is **not** computed: prices change and are not hard-coded.
2. **Prompt variants, one variable each.** A = current rules (control). B = A + optional `unsupported` array (what the question asked about but the evidence does not show). C = A + "a claim must be fully entailed by its cited evidence; trim or drop partial support; never combine two excerpts into a claim neither supports alone". Tests assert every shared rule is present in all three, each variant adds only its own text, and the user message is byte-identical across variants.
3. **Human-labelled support set** (`dataset/v2/support.{tuning,holdout}.json`): 28 claims, each with claim text, evidence range, label (SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED), acceptable paraphrases and rationale. 16 tuning (incl. 2 adversarial from the fixture, 1 negative) and 12 holdout, frozen in the lock. Labels: 14 supported, 3 partial, 7 unsupported, 4 contradicted. Every evidence range was validated against the pinned source.
4. **Judge harness** (`src/answer/judge.ts`): prompt that shows the judge only the claim and the excerpt, treats the excerpt as untrusted data, strict output parsing, confusion matrix, accuracy, Cohen's kappa, and two separately counted error types: **unsafe agreements** (judge approves what the reference rejects) and **over-rejections**. Provider failures are counted as "unclassified", never as agreement.
5. **Semantic-attack suite**: the 8 required attacks (irrelevant evidence, misleading wording, half support, contradiction, instruction override, secret request, cite-irrelevant-file, authority redefinition) as questions over a synthetic repository, with deterministic pass/fail checks on what the model **said and cited**.
6. **Source cache** (`src/answer/source-cache.ts`): `SourceCache` interface; `MemorySourceCache` (LRU by bytes), `FsSourceCache` (files named by hash of the key, atomic writes, corrupt entry = miss, oldest-first byte trim), and `CachingSource` (SHA-keyed, TTL, negative TTL, size limit, concurrent-request coalescing, bounded retry with backoff).

## Results that exist

**FACT, semantic-attack suite, deterministic baseline (NOT a model):** 6 of 8 pass; SA1 and SA7 fail because the baseline cites `docs/cite-me.md`, a keyword-stuffed file that reaches the top-8 evidence even after test/docs demotion. **OBSERVATION:** the other six passes say little: the baseline makes templated claims, so there is little to violate. A scripted careful model passes 8/8 and a scripted obedient one fails (tests). **INFERENCE:** retrieval can expose a model to hostile evidence even when no model is involved; that exposure is measurable now.

**FACT, source cache, emulated upstream (120 ms/request; not GitHub):**

| Path | Result |
|---|---|
| Miss | 124.9 ms median (= upstream) |
| Memory hit | 0.014 ms |
| Disk hit after reopening the cache | 0.95 ms, 0 upstream calls |
| 200 concurrent requests, 10 hot files | 10 upstream calls, 190 coalesced, 133 ms wall |
| Upstream fails every 3rd call, 2 retries | 30/30 succeed, 14 retries |
| 100 KB byte limit, 50 files | 31 evictions, 100,339 bytes held |

**FACT, real GitHub through the real route** (local standalone server, extractive stand-in model): first answer 1.1 s of source time for 8 files, repeat 7 ms. Earlier Phase 3 measurement (real GitHub, 9 requests) was ~346 ms/request sequentially; the route now fetches 4 files in parallel.
**UNCERTAINTY:** unauthenticated GitHub is still 60 requests/hour; the cache removes repeats, not first fetches.

## What Phase 4 proved

- The remaining pieces of the support-evaluation pipeline exist and are tested, so a real run needs only an API key.
- The source-cache design behaves correctly under hit/miss/TTL/size/concurrency/failure, locally.
- Retrieval itself can surface injected, keyword-stuffed evidence; that is now measured.

## What remains unproven

Everything the phase was for: whether a real model's cited, SHA-pinned evidence supports its claims; its fabrication, refusal and provider-failure rates; judge agreement; which prompt variant helps; the final holdout numbers; real Vercel and object-storage behaviour.

## Is grounded answering strong enough to begin UI? **No.**

The structural half is solid; the semantic half has zero real-model evidence. Starting a UI now would present citations as proof of support, which is exactly the unproven claim. A UI that shows citations without a support signal would also have no data to decide what to show.

## Architecture changes justified by evidence

None to retrieval, citation validation or prompt boundary. Additions are tooling plus the source cache, justified by the measured GitHub request cost (3-8 requests per uncached answer).

## Exact next phase

**Phase 4b: run it with credentials (one session, no new code needed).**
1. A person reviews the 28 draft labels and records reviews in `support.review.json` (anything unreviewed stays labelled as an assistant draft).
2. With `ANTHROPIC_API_KEY` set: `answer-run tuning` for prompt variants A, B, C (one change each), `judge-eval tuning`, `semantic-attacks A|B|C`. Report claim -> citation -> evidence -> support by hand-labelling the model's tuning claims via an export of claim + cited text.
3. Freeze the winning variant; exactly one `answer-run holdout --final` and one `judge-eval holdout --final`.
4. Provide a `GITHUB_TOKEN` and choose where the source cache lives; then one real Vercel + object-store smoke test if access is granted.

## Phase 4b addendum: human review gate

- Review document: `reports/private/phase4b-support-review.md` (kept out of the repository because it quotes third-party source) (all 28 claims: id, split, repository + pinned SHA, question, claim, current draft label, evidence path and range, excerpt, draft rationale). Drafts are unchanged.
- Review file: `src/benchmark/dataset/v2/support.human-review.json`, 28 entries, all `reviewed: false`, `final_label: null`. Allowed labels: SUPPORTED, PARTIAL, UNSUPPORTED, CONTRADICTED. A reviewed entry overrides the draft; unreviewed entries stay assistant drafts. `exp-cli support-review-status` validates the file and prints "N of 28 reviewed".
- OBSERVATION (retained, no fix made): the deterministic semantic-attack suite passes 6 of 8. SA1 and SA7 fail because keyword-stuffed `docs/cite-me.md` can reach the top-8 evidence. Retrieval can surface hostile or irrelevant evidence. Ranking/demotion stays unchanged until real-model evidence exists.
- No model, judge, prompt-variant or holdout run was made. Source cache unchanged.
