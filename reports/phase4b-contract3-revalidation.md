# Phase 4B: evidence contract 3 and the re-validation of the five stored runs

Date: 2026-10-09. No model was called. No holdout, no winner. The contract-2 result files are unchanged.

## What changed

Under evidence contract 2 a quote longer than 400 characters made the whole reply malformed, before anyone checked whether the quote was real. Every run lost two or three whole answers that way, to real code quoted at length, and five prompt wordings did not stop it.

Evidence contract 3 (`src/answer/validate.ts`) changes that one rule:

- A quote over 400 characters is checked like any other: verbatim, one continuous passage, in the one block its entry names.
- Only after that check is it cut, for keeping and for display, to its first 400 characters (at a line end where there is one) and marked as trimmed.
- A quote over 4,000 characters is still refused unread.
- Everything else is contract 2.

The trimmed text is an excerpt for the reader. It is not a new basis for anything: as before, the validator says nothing about whether the lines support the claim.

The web application still enforces contract 2. New evaluation runs use contract 3 and are named `-e3`; a test checks that no new run can be given a `-e2` name.

## How the stored runs were re-validated

`npx tsx scripts/revalidate-contract3.ts`. For each of the five runs it reads the contract-2 result file and the private record of the model's replies. The two contracts differ only for replies with an over-long quote, and contract 2 always withheld those as `quote-too-long`; so only those cases are validated again, from the stored reply, against the same evidence blocks read from the same pinned commit. Every other record is carried over as it was. Each run gets a new `-e3` file that names the file it came from.

## What happened to the cases that had been withheld for length

| Run | Case | Under contract 3 |
|---|---|---|
| A | zustand-8, hono-6 | both answered |
| B | react-1, zustand-8, hono-6 | all three answered |
| C | express-2 | answered |
| C | zustand-8, hono-6 | still withheld: the long quote is **not** verbatim in the cited block |
| D | express-2 | answered |
| D | zustand-8 | still withheld: not verbatim |
| E-v3 | ky-1, commerce-3 | both answered |

Of 12 such cases, 9 become answers and 3 fail the real check instead. That is the point of the change: length alone no longer decides, and a long quote that is wrong is still caught.

## Results, contract 2 and contract 3 side by side

Same replies, same evidence; only the rule on quote length differs. Not to be mixed: a contract-3 figure is comparable only with other contract-3 figures.

**Contract 2 (as recorded)**

| | A | B | C | D | E-v3 |
|---|---|---|---|---|---|
| Answered | 18 | 14 | 16 | 16 | 17 |
| Not enough evidence | 11 | 12 | 13 | 12 | 12 |
| Withheld | 3 | 6 | 3 | 4 | 3 |
| — quote too long | 2 | 3 | 3 | 2 | 2 |
| — quote not in the cited lines | 1 | 3 | 0 | 2 | 1 |
| Claims in answered replies | 22 | 17 | 20 | 21 | 24 |
| Answerable questions answered (of 24) | 17 | 14 | 16 | 15 | 17 |
| Unanswerable questions refused (of 8) | 7 | 8 | 8 | 7 | 8 |

**Contract 3 (re-validated, no model call)**

| | A | B | C | D | E-v3 |
|---|---|---|---|---|---|
| Answered | 20 | 17 | 17 | 17 | 19 |
| Not enough evidence | 11 | 12 | 13 | 12 | 12 |
| Withheld | 1 | 3 | 2 | 3 | 1 |
| — quote too long | 0 | 0 | 0 | 0 | 0 |
| — quote not in the cited lines | 1 | 3 | 2 | 3 | 1 |
| Claims in answered replies | 25 | 21 | 22 | 23 | 29 |
| Answerable questions answered (of 24) | 19 | 17 | 17 | 16 | 19 |
| Unanswerable questions refused (of 8) | 7 | 8 | 8 | 7 | 8 |

Under contract 3, E-v3 answers 19 of the 24 answerable questions and refuses all 8 unanswerable ones, with one answer withheld. A answers as many but lets one unanswerable question through.

## Files

| Contract 2 (unchanged) | SHA-256 prefix | Contract 3 (new) | SHA-256 prefix |
|---|---|---|---|
| `…-A-e2.tuning.json` | `174F3F05` | `…-A-e3.tuning.json` | `EC173C70` |
| `…-B-e2.tuning.json` | `946760CE` | `…-B-e3.tuning.json` | `8E170DE3` |
| `…-C-e2.tuning.json` | `2681E31E` | `…-C-e3.tuning.json` | `79C7159C` |
| `…-D-e2.tuning.json` | `8969AE91` | `…-D-e3.tuning.json` | `27264FD8` |
| `…-E-e2-v3.tuning.json` | `9D5F7CAD` | `…-E-e3-v3.tuning.json` | `380C639B` |

All under `reports/phase3/`, named `answers.groq.run-0.3-0.5-<tag>.tuning.json`.

## Limits

- The claims that became answers have not been read by anyone against their lines. The 12 re-validated cases add claims that no assistant reading and no owner review has covered yet.
- A long quote is slower for a reader to check than a short one. Only its first 400 characters are shown.
- These are the same single runs on the same tuning questions as before; contract 3 changes how their replies are judged, not what the model wrote. The holdout is untouched.
- Private per-claim records and the review package are still the contract-2 ones.

## An environment note

The benchmark cache (the pinned tarballs and the indexes built from them) lives in the operating system's temporary folder and had been removed, most likely by an automatic clean-up; the disk has about 6 GB free. It was rebuilt for the tuning repositories from GitHub. The rebuilt indexes give the same retrieval results as the recorded run in every case (the only differences are a few bytes in the compressed artifact sizes). The cache should live somewhere that is not cleaned automatically.
