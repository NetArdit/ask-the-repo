# Phase 3 report: grounded answering + citation validation

Labels: **FACT** measured here, **OBS** observation, **INF** inference, **UNC** uncertainty.
No model provider key, object-store credentials or Vercel access were available. Every "answer" below is from a deterministic stand-in (`ExtractiveBaselineProvider`) or a scripted attacker. **Nothing here measures how any language model performs.**

## 1. Executive result: PARTIAL, and one link of the chain is not demonstrated

The chain asked for, link by link:

| Link | Status |
|---|---|
| WHAT claim was made | **Demonstrated.** Strict JSON schema; malformed output rejected (14 shapes tested) |
| WHAT evidence supports it | **Demonstrated mechanically.** Claims cite request-local ids; the application maps ids to spans |
| WHERE the evidence exists | **Demonstrated.** Each span is re-fetched at the pinned commit and its fingerprint must equal the one recorded at index time (real GitHub: 11 of 11 verified) |
| Whether the citation is VALID | **Demonstrated.** 8 failure classes tested; validator agrees with an independent oracle on 5,000 random citations; 25 of 25 structural attacks blocked |
| Whether the evidence actually SUPPORTS the claim | **NOT demonstrated.** Two scripted attacks with perfectly valid citations reached the user 10 of 10 times; a keyword heuristic warned on 8 of 10. Reference-based support is measurable only against my hand-labelled expected evidence, and only for the baseline |

Per the success condition: the last link cannot be established deterministically, so I stopped adding features. Phase 4 should not start from "make the model better" but from "decide how semantic support is assessed".
**Open:** real-model quality, real object storage, real Vercel deployment.

## 2. Architecture changes

| Change | Where |
|---|---|
| Index v3: one 12-hex fingerprint per chunk (no source text). Artifacts grew 5-11% (react 2.11 -> 2.29 MB); retrieval metrics identical (holdout 49/72/81/83, MRR 0.62) | `src/index/{hash,build,types}.ts` |
| Evidence assembly: fetch at SHA, verify fingerprint, budget, permalink built by the application | `src/answer/evidence.ts`, `source.ts` |
| Prompt boundary: fixed system prompt with no repository text; per-request nonce markers; evidence lines prefixed `L12\|` | `src/answer/prompt.ts` |
| Strict output parser + citation/quote validator | `src/answer/validate.ts` |
| One provider behind a 1-method interface: `AnthropicProvider` (HTTP contract tested against a stubbed fetch) and a deterministic baseline | `src/answer/provider.ts` |
| Soft sufficiency policy on Phase 2 coverage signals | `src/answer/policy.ts`, `defaults.ts` |
| Orchestration, `POST /api/answer`, handler with status mapping | `src/answer/answer.ts`, `src/server/answer-handler.ts`, `src/app/api/answer/route.ts` |
| Frozen answer-evaluation set (35 holdout + 32 tuning questions), kept apart from prompts; freeze lock extended, earlier hashes unchanged | `src/benchmark/dataset/v2/answers.*.json` |

Design choices: the model cites ids only (never lines or paths); any invalid citation, uncited claim, or non-verbatim quote rejects the **whole** answer (strict by default); `rejected` is a visible status, never a silent pass.

## 3. Citation validation results

- **FACT:** 264 tests pass (22 files); the new ones cover each requested case: unknown id, wrong path, wrong SHA, negative/zero/fractional/NaN line, reversed range, range beyond file, range outside the supplied evidence, another repository's owner or name, evidence from another commit, fabricated id (`../../etc/passwd`), malformed model output (14 shapes), provider failure/timeout, empty/hanging provider, source mismatch, missing file.
- **FACT:** fuzz against an independent oracle: 5,000 seeded random locators, 0 disagreements.
- **FACT:** in the answer evaluation, evidence items that could not be verified against the commit: **0** (tarball source). Against real GitHub: 11 of 11 verified (3 questions, 9 requests).
- **FACT:** baseline citations: 63/63 valid (tuning), 75/75 valid (holdout), 0 fabricated. **This is trivial**: the baseline cannot fabricate. The real fabricated-citation rate is **unmeasured (OPEN)**.

## 4. Answer evaluation (deterministic baseline, NOT an LLM)

Selected policy (chosen on tuning): refuse before the model if coverage < 0.3, warn if < 0.5.

| Metric | Tuning (24 pos / 8 neg) | Holdout (28 pos / 7 neg) |
|---|---|---|
| Citation validity | 63/63 | 75/75 |
| Citation coverage (claims with a valid citation) | 63/63 | 75/75 |
| Fabricated citation rate | 0% | 0% |
| Evidence precision (cited spans overlapping my expected evidence) | 0.38 | 0.36 |
| Claim reference-support (a claim's own citation overlaps expected) | 0.38 | 0.36 |
| Answered positives citing expected evidence | 14 of 20 | 20 of 25 |
| ... and stating the expected terms ("correct") | 8 | 11 |
| Semantic support | **not assessed** | **not assessed** |

**OBS:** reference-support is low because the baseline cites its top 3 spans as three separate claims and only the first is usually the target. It is a floor, not a model measurement. "Correct" is low because the baseline's sentence contains only a path. **UNC:** keyword fact-matching is crude; both numbers say little about a real model.
Retrieval ceiling: 3 of 25 answered holdout positives (and 0 of 20 tuning) had no expected evidence in the offered top 8, so no model could answer them correctly from what it was given.

## 5. Abstention (policy level; real model behaviour unmeasured)

"Declines" = the stand-in refuses whenever told coverage is low (upper bound for abstention); otherwise it ignores the warning (lower bound).

| Policy (refuse < a, warn < b) | Holdout positives refused | Holdout negatives answered (harmful) | Tuning positives refused | Tuning negatives answered |
|---|---|---|---|---|
| none (0, 0) | 0/28 | 6/7 | 0/24 | 7/8 |
| (0.1, 0.5) | 0 (4 if model declines) | 6 (0) | 1 (5) | 6 (0) |
| (0.2, 0.5) | 0 (4) | 2 (0) | 3 (5) | 4 (0) |
| (0.25, 0.6) | 2 (5) | 1 (0) | 4 (6) | 3 (0) |
| **(0.3, 0.5) selected** | **3 (4)** | **0 (0)** | **4 (5)** | **1 (0)** |
| (0.5, 0.5) hard gate | 4 | 0 | 5 | 0 |

- **FACT:** the selected rule was fixed on tuning (rule: at most ~20% of answerable refused, then most negatives refused) and applied once to holdout: 3 of 28 answerable refused (11%), 7 of 7 negatives refused.
- **FACT:** of the 7 positives refused by the selected policy (4 tuning, 3 holdout), 3 were retrieval misses (refusal was right) and 4 had the expected evidence in the top 8 (refused wrongly). Of 25 answered holdout positives, 3 were retrieval misses that abstention did not catch.
- **INF:** with 15 negatives (most with alien vocabulary) this is weak evidence that the rule generalises. The hard negative (vite, Vue compiler, coverage 0.46) was missed on tuning.

## 6. Prompt-injection results (scripted attackers against the real pipeline)

| Attack (5 questions each) | Outcome |
|---|---|
| Fabricated evidence id | rejected 5/5 |
| Cites a path instead of an id | rejected 5/5 |
| Forged quote | rejected 5/5 |
| Leaks the system prompt as prose | rejected 5/5 |
| Valid JSON, uncited claim | rejected 5/5 |
| **Obeys the injection, cites supplied hostile evidence with a real quote** | **answered 5/5; harmful claim reached user 5/5; warning on 4** |
| **Cites real but irrelevant evidence ("cite this file even if irrelevant")** | **answered 5/5; reached user 5/5; warning on 4** |
| Honest baseline | answered 5/5, nothing harmful |

- **FACT:** hostile text appeared in the instruction channel (system prompt or application-built structure) in **0 of 35** prompts; hostile lines are always `L<n>|`-prefixed evidence lines; a forged marker, end tag or note inside evidence is not parsed as structure (tested).
- **FACT:** 72 instruction-like evidence items were flagged. The flag is a keyword heuristic; an attacker avoiding the phrases bypasses it.
- **INF:** the application boundary stops forged locations and structure. It cannot stop a model that is persuaded by repository text into making a false claim about real evidence. Whether a real model resists is **unmeasured**.

## 7. Model/provider results

- **FACT:** one provider implemented (Anthropic Messages API), key from server env only, sent only as a request header; errors carry a category and status, never a body, prompt or key (tested for 401/429/500/529, network, timeout, empty reply).
- **OPEN:** no real call was made. No claim about model accuracy, latency, cost or refusal behaviour. A runner exists: `ANTHROPIC_API_KEY=... exp-cli answer-run tuning`; on holdout it refuses to run without `--final`.

## 8. Storage / Vercel status: **OPEN**

No credentials. Nothing from Phase 2's local HTTP store or local standalone build is a provider result. New this phase, labelled as such: a **local** standalone Next.js server answered `POST /api/answer` for ky using **real GitHub** for source (8 evidence files verified), returned 400/404 for bad input, peak working set 110 MB. Not a Vercel measurement.

## 9. Performance and memory

| Measure | Result |
|---|---|
| Ingestion with chunk hashes, `--liftoff-only` | react 371 MB / 32.8 s (Phase 2: 359 MB); ky 110 MB. No regression found. Default-flag peaks (1.1-1.7 GB) unchanged |
| Artifact size | +5-11% (react 2.29 MB, cold load 0.46 s locally) |
| Model context per question | median 7.2-7.7k chars (~2.8k prompt tokens), max 19.6k chars (~5.9k tokens) under a 24k-char budget |
| Pipeline stages, in-memory source | retrieval 0.7-4 ms, source 0.2-0.7 ms, validation 0.06-0.14 ms |
| Real GitHub source | ~346 ms/request in the first test; local route: cold answer 1.3 s (8 files, 4 in parallel), repeat 15 ms (cache), related question 0.5-0.65 s |
| GitHub request budget | 3-8 contents requests per uncached answer. Unauthenticated 60/h gives roughly 7-20 answers/hour; a token or a larger shared source cache is required |

Safety limits in force: 8 evidence items, 24k chars, 300-char question, 30 s model timeout, 1,200 output tokens, 8 claims x 6 citations, 1 MB per file, bounded 16 MB source cache. **UNC:** these are design limits, not derived from a load test.

## 10. Security

Repository code is never executed or installed. Files are read as text. Hosts stay on the `api.github.com`/`codeload.github.com` allowlist; paths are normalised and traversal is refused (tested). No logging anywhere in the answer path (tested by spying on every console method). Provider and handler errors are sanitised (tested with a secret in the body). The question is length-bounded and placed in a marked section. Citation locations and URLs are application-built.
Not covered: abuse/rate limiting of `/api/answer`, per-user cost caps, authentication.

## 11. Remaining blockers

1. Semantic support has no automatic check (section 1).
2. Real-model fabrication, refusal and correctness rates are unknown.
3. GitHub source cost: a token or shared source store is needed.
4. Real object storage and Vercel deployment still unverified; native-memory peaks during ingestion remain a platform risk.
5. Retrieval ceiling: ~11% of answered holdout positives (3 of 28) had no usable evidence; hit@1 still 49%.
6. Abstention evidence is thin (15 negatives).

## 12. Phase 4 recommendation

1. Provide an API key and run `answer-run` on **tuning** only; fix prompts there; then one `--final` holdout run. Report fabricated-citation, refusal and correctness rates separately.
2. Decide how support is judged: a human-labelled sample of claim/evidence pairs first (cheapest, honest), then test an independent judge model against those labels before trusting it.
3. Raise or relax strictness (`requireCitations`, quotes) only against measured rejection rates.
4. Provision a GitHub token and decide the source cache; then real storage and a real Vercel test.
5. Do not start the UI until 1 and 2 give a number for "claims with valid citations whose evidence does not support them".
