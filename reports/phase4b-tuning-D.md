# Phase 4B: prompt variant D on the tuning split

Date: 2026-10-09. One run, tuning split only. No holdout call, no judge run, no winner. The per-claim readings below are an assistant's, single pass, and are **not** the owner's review; Gate 5 is not passed.

## What was run

| | |
|---|---|
| Variant | D, added in commit `fd2e5b2`. Not a single-factor change: C's entailment rule, B's optional `unsupported` list, and three scoping rules (a call is not a definition; a list is not a complete list; an entry point needs its declaration). Compare it with C. |
| Why | The owner's review found partial and unsupported claims (`reports/gate5-evidence-gap-audit.md`). |
| Model, split, evaluator | `openai/gpt-oss-120b` through Groq's free tier, temperature 0; 32 tuning questions; evidence contract 2; same retrieval, validator, policy thresholds 0.3 / 0.5, runner and pacing as A, B, C. |
| Run | 32 of 32 cases in one pass, no resume, no provider failure. 21 model calls; 11 questions were refused by the retrieval policy without a call, as in every variant. |
| Artifacts | `reports/phase3/answers.groq.run-0.3-0.5-D-e2.tuning.json` (SHA-256 prefix `8969AE914FE296F8`) and its checkpoint. |
| A, B, C untouched | Their result files hash to `174F3F05956E12A0`, `946760CEA5EA694A`, `2681E31EC2ECE491` before and after the run, identical to the committed versions. Their system prompts are pinned by hash in a test. |

## Results

All four columns are computed the same way from the four contract-2 result files.

| | A | B | C | D |
|---|---|---|---|---|
| Model calls | 21 | 21 | 21 | 21 |
| Answered | 18 | 14 | 16 | 16 |
| Not enough evidence | 11 | 12 | 13 | 12 |
| — of which the model itself declined | 0 | 1 | 2 | 1 |
| Withheld (failed a citation check) | 3 | 6 | 3 | 4 |
| — quote not in the cited lines | 1 | 3 | 0 | 2 |
| — quote longer than 400 characters | 2 | 3 | 3 | 2 |
| Claims, accepted and withheld | 24 | 21 | 20 | 25 |
| Claims in answered replies | 22 | 17 | 20 | 21 |
| Structurally valid citations | 35/35 | 29/29 | 25/25 | 41/41 |
| Answerable questions answered (of 24) | 17 | 14 | 16 | 15 |
| Unanswerable questions refused (of 8) | 7 | 8 | 8 | 7 |
| Reference-supported claims (owner-supplied labels) | 0.857 | 0.941 | 0.900 | 0.800 |
| Input tokens, all calls | 74,273 | 75,301 | 75,400 | 77,721 |

### Where D differs from C

| Case | C | D | What happened |
|---|---|---|---|
| ky-1 | answered, 1 claim | **withheld**, 3 claims | D found more (the default formula and the header-timing function) but shortened two quotes with "..." so they are not verbatim. Its first claim is the scoped wording the new rule asks for. |
| vite-6 | answered, 1 claim | **withheld**, 1 claim | Quotes written with "(...)" in place of the parameter list. |
| vite-10 (unanswerable) | declined | **answered**, 1 claim | D says a compiler "is implemented in" an external package on the strength of a comment that some logic was copied from it. C correctly declined. |
| react-1 | answered, 2 claims | answered, 3 claims | D adds a third place where the function is implemented. |
| koa-5 | answered, 4 claims | answered, 3 claims | D drops the claims that described what a called function does. |
| hono-6 | withheld (quote too long) | **answered**, 2 claims | D quotes shorter passages. |

## Assistant reading of D's 25 claims (not owner review)

Scale as in the earlier reading: **plausible** = the cited lines appear to establish the claim as worded; **partial** = they establish part of it. Per-claim text and the cited lines are in the private package (`reports/private/review/review-D.md`).

| Claim | Reading | Note |
|---|---|---|
| ky-1/D/1 | plausible | Says the delay "is obtained by calling" the method. No claim about how it is computed. (Case withheld.) |
| ky-1/D/2 | partial | The default formula is shown as documented; "if no retry-timing header is used" is not shown. (Case withheld.) |
| ky-1/D/3 | partial | The function's definition is shown; two of three quotes are not verbatim. (Case withheld.) |
| ky-6/D/1 | plausible | True for the one module named. The question asks which modules; two more exist per the reference; no "covers the evidence provided" qualifier. |
| express-1/D/1 | plausible | Definition quoted in full. |
| commerce-1/D/1 | plausible | |
| commerce-3/D/1 | plausible | Now cites the definition that makes the first call an optimistic update; the earlier variants inferred it from the name. |
| commerce-8/D/1 | partial | "The files that import ... are" two files: exhaustive wording the lines cannot show. The new rule was not followed. |
| vite-2/D/1 | plausible | |
| vite-6/D/1 | plausible | Claim is true for the file named; both quotes are not verbatim. (Case withheld.) |
| vite-10/D/1 | partial | Only "logic was copied from that package" is shown; "is implemented in" it is not. The owner marked this question unanswerable. |
| react-1/D/1, /2, /3 | plausible | Three implementations, each with its lines. "For debugging purposes" in /3 rests on the package name. |
| react-6/D/1 | plausible | The call and its comment are shown; "after rendering" is still inferred. |
| zustand-1/D/1 | plausible | |
| zustand-4/D/1 | plausible | True for the one module named; the reference lists another; no qualifier. |
| koa-1/D/1 | plausible | |
| koa-3/D/1 | partial | "The modules that import ... are" three modules: exhaustive wording again. |
| koa-5/D/1 | plausible | "By calling compose" is shown; "into a single function" rests on the name. |
| koa-5/D/2, /3 | plausible | Both now describe only calls that are in the quoted lines. |
| hono-1/D/1 | plausible | |
| hono-6/D/1, /2 | plausible | Shown in detail for one router class; the repository has others, and the reference points at different files. |

Count: 20 plausible, 5 partial, none contradicted. The earlier reading of C was 18 plausible, 2 partial of 20. These are one reader's single pass over one run each; the difference between them is not a measurement.

## What D did to the three gap patterns

1. **Call cited, definition missing.** Better. Where C and A described what a called function does, D either says only that it is called (ky-1, koa-5) or brings the definition (commerce-3). Two small leftovers (react-6, koa-5/D/1).
2. **Lists that cannot be shown complete.** Not improved. D still writes "the files that import ... are" (commerce-8, koa-3) and still names one importer without saying there may be more (ky-6, zustand-4). The model did not follow the new rule. This is the pattern the index could answer as data (`reports/route2-benchmark-v3-design.md`).
3. **Entry point without its declaration.** Partly. On react-4 the model now declines instead of asserting. express-2 is still withheld for a quote over 400 characters.

## Cost of D

- Two answers C gave are lost to quotes that are not verbatim (ky-1, vite-6): D's longer answers tempt the model to abbreviate code with "...".
- One unanswerable question that C declined is answered (vite-10).
- One answer gained (hono-6).

## Conclusion, stated narrowly

On this one run D is not better than C overall. It improves the wording of claims about called functions, changes nothing about incomplete lists, and trades two answers for one. Nothing here selects a variant. The evidence gap behind most partial claims is not a wording problem, which is the case for Route 2; whether to do Route 2 is the owner's decision.

## Not done

No holdout run, no judge run, no adversarial run, no second run of D, no change to A, B, C.
