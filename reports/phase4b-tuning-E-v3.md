# Phase 4B: version 3 evidence with prompt E, on the version 2 tuning questions

Date: 2026-10-09. One run. No holdout call, no judge run, no winner. The per-claim readings are an assistant's, single pass, and are **not** owner review; Gate 5 is incomplete.

## What was run

| | |
|---|---|
| Command | `answer-run tuning 0.3 0.5 --variant=E --evidence=v3` |
| Evidence | Version 3, changes 2 and 3 of `reports/route2-benchmark-v3-design.md`: importers read from the index's import table, and declared entry points with the manifest lines that declare them. The application states those facts itself; the model is shown the lines. Change 1 (definitions) was left out. |
| Prompt | E (commit `888795c`, SHA-256 `60cea64b…`): D's rules plus "copy every quote exactly" and what an INDEX line is. |
| Everything else | Same model (`openai/gpt-oss-120b`, Groq free tier, temperature 0), same 32 tuning questions and owner reference, same retrieval, validator, evidence contract 2, thresholds, runner and pacing. |
| Run | 32 of 32 in one pass, no provider failure, 21 model calls. |
| Artifacts | `reports/phase3/answers.groq.run-0.3-0.5-E-e2-v3.tuning.json` (SHA-256 prefix `9D5F7CAD`) and its checkpoint. A, B, C, D files unchanged (`174F3F05`, `946760CE`, `2681E31E`, `8969AE91`). |

**Limits on what this shows.** One run. The changes were designed against these same tuning questions. Relative to D two things changed at once (the evidence and two prompt rules), so the run cannot say which did what. A better result is a reason to continue, not proof.

## Results

| | A | B | C | D | E-v3 |
|---|---|---|---|---|---|
| Model calls | 21 | 21 | 21 | 21 | 21 |
| Answered | 18 | 14 | 16 | 16 | 17 |
| Not enough evidence | 11 | 12 | 13 | 12 | 12 |
| Withheld (failed a citation check) | 3 | 6 | 3 | 4 | 3 |
| — quote not in the cited lines | 1 | 3 | 0 | 2 | 1 |
| — quote longer than 400 characters | 2 | 3 | 3 | 2 | 2 |
| Claims in answered replies | 22 | 17 | 20 | 21 | 24 |
| Structurally valid citations | 35/35 | 29/29 | 25/25 | 41/41 | 36/36 |
| Answerable questions answered (of 24) | 17 | 14 | 16 | 15 | 17 |
| Unanswerable questions refused (of 8) | 7 | 8 | 8 | 7 | 8 |
| Answered and cites a reference file | 16 | 13 | 15 | 14 | 15 |
| Cases with a fact stated by the application | 0 | 0 | 0 | 0 | 7 |
| Reference-supported claims (owner-supplied labels) | 0.857 | 0.941 | 0.900 | 0.800 | 0.792 |
| Input tokens, all calls | 74,273 | 75,301 | 75,400 | 77,721 | 81,644 |

E-v3 is the only run that both answers 17 of the 24 answerable questions (as A does) and refuses all 8 unanswerable ones (as B and C do). The "reference-supported" figure fell slightly; it counts overlap with the owner's reference ranges, which the manifest and import-line citations often fall outside.

## What changed in the three gap patterns

**Who imports it (pattern 2): fixed in all four questions.** Each answer now names every source importer, with each import line quoted, and the list equals the owner's reference.

| Case | C | D | E-v3 |
|---|---|---|---|
| ky-6 | 1 of 3 importers | 1 of 3 | all 3, each quoted |
| commerce-8 | 2 of 2, "the files are" | 2 of 2, "the files are" | 2 of 2, one claim each |
| zustand-4 | 1 of 2 | 1 of 2 | both, each quoted |
| koa-3 | 3 of 3 | 3 of 3 | 3 of 3 |

The application additionally states the count itself (for ky-6: 14 files, 3 in source and 11 in tests).

**Entry point (pattern 3): improved.** react-4 was "the entry point is index.js" on a licence header (A, B), then declined (C, D); now it quotes the manifest's `"main": "index.js"`. express-2, withheld in C and D, is answered: the file and what it exports are quoted, and the application states that the manifest declares no entry field.

**Call without definition (pattern 1): unchanged by design**, since change 1 was not in this run. D's narrower wording carries over.

## What it cost

- **ky-1 and commerce-3 are withheld for a quote over 400 characters.** Both were answered by C; ky-1 is the case the owner read. The new rule ("if the passage is long, quote one line") was not followed there. A quote over the limit withholds a whole answer in every run so far (2 or 3 cases each time). This is now the largest single source of lost answers, and it is a rule of the evidence contract, not of retrieval or wording.
- zustand-8 is still withheld (a quote not verbatim), though its claim now points at the right place, the manifest's exports field.

## Assistant reading of the 25 claims (not owner review)

Read against the cited lines where the evidence is new (ky-6, express-2, react-4, react-6, zustand-4), and against the same blocks read for D elsewhere. **plausible** = the cited lines appear to establish the claim as worded; **partial** = part of it.

| Claims | Reading | Note |
|---|---|---|
| ky-6/1 | partial | The three files named each have their line quoted. "The modules that import … are" these three leaves out the 11 test files, which only the application's fact mentions. |
| commerce-8/1, /2; zustand-4/1; koa-3/1 | plausible | Every named importer is quoted, and the index lists exactly these. |
| react-4/1 | plausible | The manifest line is quoted. |
| express-2/1, /2 | plausible | What index.js exports and where the application is created are quoted; "entry point" rests on the application's fact, since the manifest declares none. |
| express-1/1, commerce-1/1, vite-2/1, vite-6/1, react-1/1–3, zustand-1/1, koa-1/1 | plausible | Short "X is implemented in file F" claims with the definition line quoted. |
| react-6/1 | plausible | "After rendering" is still inferred. |
| koa-5/1–3 | plausible | Two small phrases rest on function names ("into a single function", "to send the response"). |
| hono-6/1, /2 | partial | True of the one router class cited; the claims now say "the router" and the repository has several. D named the class. |
| zustand-8/1 | partial | Withheld; right place, quote not verbatim. |

Count: 21 plausible, 4 partial, none contradicted (D: 20 and 5; C: 18 and 2 of 20). One reader, one pass, one run each: not a measurement.

## Conclusion, stated narrowly

On this one run, version 3 evidence with prompt E did what it was built for: the four importer questions are answered completely and the entry-point questions are answered from the manifest, without losing a refusal. It did not improve the definition pattern (not attempted) and lost two answers to over-long quotes. Nothing here selects a variant or shows the result would hold on other questions; the holdout is untouched.
