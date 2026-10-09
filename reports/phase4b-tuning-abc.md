# Phase 4B, gate 3–4: prompt variants A, B and C on the tuning split

> **Historical: evidence contract 1.** These runs were validated under the first quote rule (one loose quote per claim, accepted if it occurred in any cited block). That rule has been replaced; see `reports/README.md`. The figures below are kept as recorded and are **not comparable** with runs under contract 2.

Status: **data collected, not reviewed.** This report stops at the human-review gate. It names no winner, freezes nothing, and nothing in it was run on the holdout split.

## What was run

| | |
|---|---|
| Model | `openai/gpt-oss-120b` through Groq (free tier), temperature 0 |
| Split | tuning only: 32 questions over 8 repositories (24 answerable, 8 that the repository cannot answer) |
| Held constant | retrieval, evidence selection and text, citation validator, policy thresholds 0.3 / 0.5, output schema, runner, pacing |
| Varied | the system instructions only. A is the control; B adds an optional list of what the evidence does not show; C adds "a claim must be fully entailed by the evidence it cites". The user message was byte-identical across variants. |
| Runs | one run per variant. A and B on 2026-10-05; C resumed from its checkpoint across several quota windows and finished on 2026-10-06. |
| Artifacts | `reports/phase3/answers.groq.run-0.3-0.5{,-B,-C}.tuning.json` and the checkpoints beside them |

## Results

| | A | B | C |
|---|---|---|---|
| Model calls (11 questions were refused by the retrieval policy without a call) | 21 | 21 | 21 |
| Answered | 16 | 15 | 16 |
| Not enough evidence | 11 | 11 | 11 |
| Withheld (failed a citation check) | 5 | 6 | 5 |
| — quote not verbatim in the cited lines | 2 | 4 | 4 |
| — reply not in the required format | 3 | 2 | 1 |
| Claims in accepted and withheld replies | 24 | 21 | 28 |
| Citations: structurally valid / total | 28 / 28 | 29 / 29 | 32 / 32 |
| Fabricated citations | 0 | 0 | 0 |
| Answerable questions answered (of 24) | 15 | 14 | 15 |
| Answerable questions refused | 4 | 4 | 4 |
| Unanswerable questions refused (of 8) | 7 | 7 | 7 |
| Unanswerable questions answered | 1 (`vite-10`) | 1 (`vite-10`) | 1 (`vite-10`) |
| Answers citing the expected evidence | 14 | 14 | 14 |
| Answers also stating the expected terms ("correct") | 14 | 14 | 14 |
| Share of claims matching the reference evidence | 0.895 | 1.000 | 0.850 |
| Input / output tokens | 72,916 / 9,081 | 73,806 / 9,625 | 74,511 / 9,176 |

The three variants ended differently on 6 of the 32 questions: `ky-1`, `commerce-3`, `vite-6`, `react-1`, `react-4`, `zustand-8`. On the other 26 the outcome was the same.

## How to read this

- **Structural validity is not support.** Every citation points to real lines at the pinned commit. Nothing here says the lines support the claims. No semantic judgement was made by a person or by a model.
- **The reference labels are not ground truth.** "Expected evidence", "correct" and the reference-match share are computed against labels the project owner drafted. They have not been independently reviewed (the claim-support review document, kept privately, records 0 of 28 reviewed).
- **One run each, 32 questions.** The differences between variants are one or two questions, and the model was not run repeatedly, so run-to-run variation is unknown. None of these differences should be treated as real.
- **The reference-match share is over different claim sets** (24, 21 and 28 claims) and is not comparable across variants.
- **Why answers were withheld is only partly known.** The records keep each claim's check result but not the model's raw reply or quoted text, so "not in the required format" cannot be broken down further.
- **Latency** in the records includes the runner's pacing waits and says nothing about the model's speed.

## What is not established

Semantic support of claims; behaviour under adversarial or instruction-bearing repositories; agreement between a judge model and human review; anything about the holdout split.

## Next gate

Human review of the claims and their cited lines (gate 5). After that, and only then: judge agreement, adversarial testing, freezing a variant, and one final run on the holdout split.

## Addendum: rerun under evidence contract 2 (2026-10-06)

The evidence contract changed (each evidence entry is one id with its own quote, checked against that block only), so the contract-1 results above are **not comparable** with anything run after it. All three variants must be rerun under contract 2. Status:

| Variant | Contract 2 tuning run | Result file |
|---|---|---|
| A | **Complete, 32/32** (12 cases from an earlier session, 20 this session; resumed from checkpoint, no repeats) | `phase3/answers.groq.run-0.3-0.5-A-e2.tuning.json` |
| B | **Incomplete, 21/32. BLOCKED by the provider's rate/quota limit** at `zustand-4`; not scored | checkpoint only |
| C | **Not started, 0/32. BLOCKED** by the same limit at `ky-1` | none |

The holdout was not touched. No winner is declared: B and C do not exist under contract 2, and one run per variant on 32 cases cannot separate them anyway.

Variant A, contract 1 vs contract 2 (same 32 cases, same model, one run each):

| | A, contract 1 | A, contract 2 |
|---|---|---|
| Answered / insufficient evidence / withheld | 16 / 11 / 5 | 18 / 11 / 3 |
| Citations structurally valid / total | 28 / 28 | 35 / 35 |
| Withheld, by structured reason | not recorded | 2 reply rejected as malformed, 1 quote not in its own citation |

Under contract 2, answerable questions answered 17 of 24, refused 4; unanswerable refused 7 of 8 (`vite-10` answered); answers citing the expected evidence 16; "correct" 15; share of claims matching the reference evidence 0.857. These use owner-supplied reference labels, which are not independent ground truth, and the per-case differences are one or two questions on a single run.

**Finding from the private raw replies (no model call needed).** All three "malformed" withholdings across variants A and B (`zustand-8`, `hono-6`, `react-1`) have a correctly shaped reply whose quote is longer than the 400-character limit (462, 550 and 576 characters). The reply is withheld because of a length limit, not because it is malformed. The validator now reports this reason explicitly ("an evidence quote is longer than 400 characters"); acceptance behaviour is unchanged. Whether to raise the limit, or to tell the model a length in the prompt, is a decision for the owner: the first changes the contract and the second changes the prompt variants, and either means rerunning.

Token use, variant A, contract 2: 74,273 input / 11,285 output over 21 model calls (11 questions were refused before any call).

## Batch 5 addendum: `quote-too-long`

- **Evaluator correction (FACT):** a reply that is correctly shaped but has an evidence quote over 400 characters is now rejected with `quote-too-long`, not `malformed-output`. The limit (400), the prompts, the benchmark, retrieval and acceptance behaviour are unchanged. Commit `2a46d32`.
- **Relabelling (FACT):** `scripts/relabel-quote-too-long.ts` re-parsed the stored private raw replies with the corrected parser and relabelled exactly three records: A `zustand-8`, A `hono-6`, B `react-1`. No model was called. Replies, answers and acceptance are identical; only the rejection code and its detail changed. A's counts (18 answered / 11 insufficient / 3 withheld) are unchanged.
- **Status (BLOCKED):** A is 32/32. B is 25/32, halted at `koa-3` with `rate_limited` (the provider's rate or quota limit; reset time unknown). C is 0/32 and was not retried after B was blocked. Neither is scored, and no winner is declared. Holdout: no calls.
- **Resume:** `node --env-file=.env.local --import tsx src/benchmark/exp-cli.ts answer-run tuning 0.3 0.5 --variant=B`, then `--variant=C`. No successful case is repeated.
- **Not generated:** the human review package waits for B and C to complete.

## Batch 6 addendum: B complete, C partial

All figures: tuning split, contract 2, 400-character quote limit, corrected `quote-too-long` classification. Not scored for a winner; one run per variant.

| | A | B | C |
|---|---|---|---|
| Source | preserved raw outputs, deterministically revalidated (not a fresh run) | actual run, 32/32 | partial, 22/32, not scored |
| Answered / insufficient / withheld | 18 / 11 / 3 | 14 / 12 / 6 | n/a |
| Structural citations valid | 35 / 35 | 29 / 29 | n/a |
| Unanswerable refused | 7 of 8 | 8 of 8 | n/a |
| Cites the expected evidence | 16 | 13 | n/a |
| Reference-supported claim share (owner-supplied labels) | 0.857 | 0.941 | n/a |
| Withheld reasons | 2 `quote-too-long`, 1 `quote-not-in-citation` | 3 `quote-too-long`, 3 `quote-not-in-citation` | n/a |

- B resumed from a 25-case checkpoint (7 new calls this batch) and completed. It has no duplicated successful cases and no holdout calls.
- C halted at `zustand-8` after 22 cases with `rate_limited`. The persisted output carries no retry or limit-type metadata, so the limit type is not determinable from it.
- No winner is established: B answers fewer questions and withholds more, and the supported-claim share rests on owner-supplied labels.

## Batch 9 addendum: C complete, final tuning table

C was resumed from its 25-case checkpoint and finished 32/32 (7 new calls; none repeated; no holdout calls). All figures: tuning split, contract 2, 400-character quote limit, one run per variant, scored by one scorer over the saved result files.

| | A | B | C |
|---|---|---|---|
| Provenance | preserved raw outputs, deterministically revalidated (not a fresh run) | actual run | actual run |
| Answered / insufficient / withheld | 18 / 11 / 3 | 14 / 12 / 6 | 16 / 13 / 3 |
| Structural citations valid | 35 / 35 | 29 / 29 | 25 / 25 |
| Answerable questions answered / refused | 17 / 4 | 14 / 4 | 16 / 5 |
| Unanswerable questions refused | 7 of 8 | 8 of 8 | 8 of 8 |
| Cites the expected evidence | 16 | 13 | 15 |
| Correct (against owner-supplied labels) | 15 | 12 | 14 |
| Claims supported by the reference (owner-supplied) | 0.857 | 0.941 | 0.900 |
| Evidence precision | 0.828 | 0.905 | 0.913 |
| Withheld reasons | 2 `quote-too-long`, 1 `quote-not-in-citation` | 3 `quote-too-long`, 3 `quote-not-in-citation` | 3 `quote-too-long` |

- **No winner is established.** The differences are small on 32 cases with one run each, every figure that mentions "supported", "correct" or "precision" rests on owner-supplied labels, and A is revalidated rather than regenerated. Structural validity says nothing about whether the cited lines support a claim.
- The human review package (`reports/private/review/`, git-ignored) now holds all three variants. Gate 5 is open and pending human review.
