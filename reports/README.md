# Evaluation reports and benchmark provenance

This folder holds the results of evaluating AskTheRepo. It contains figures, file paths, line ranges and model-written claims. It does **not** contain source code from the benchmark repositories.

## What is published and what is not

| Published here | Kept private (`reports/private/`, ignored by git) |
|---|---|
| Per-case outcomes: status, which evidence ids were cited, whether each id was real and each quote was found, structured rejection reasons, token counts | The model's raw replies and the passages it quoted |
| File paths and line ranges of retrieved and cited evidence | The human-review package, which shows cited source lines to a reviewer |
| Model-written claims about the benchmark repositories | The claim-support review document with source excerpts |
| Aggregate figures and the limits on what they show | |

Raw replies, quotes and review material quote third-party source text, so they stay on the machine that ran the evaluation. `scripts/review-package.ts` rebuilds the review package from the private records and the pinned commits.

Model-written claims in these files are outputs under test. Some are wrong. They are not statements by this project about those repositories.

## Benchmark repositories

The benchmark asks questions about fifteen open-source repositories, each at one pinned commit (`src/benchmark/dataset/v2/repos.json`). The project does not redistribute them; the evaluation downloads each commit from GitHub when it runs. Licences below were read from each repository's own licence file at the pinned commit.

| Repository | Commit | Split | Licence | Copyright holder as stated |
|---|---|---|---|---|
| sindresorhus/ky | 0d59458 | tuning | MIT | Sindre Sorhus |
| expressjs/express | 7ef9844 | tuning | MIT | TJ Holowaychuk; Roman Shtylman; Douglas Christopher Wilson |
| vercel/commerce | 3761e52 | tuning | MIT | Vercel, Inc. |
| vitejs/vite | 1003321 | tuning | MIT | VoidZero Inc. and Vite contributors |
| facebook/react | 7c6ac13 | tuning | MIT | Meta Platforms, Inc. and affiliates |
| pmndrs/zustand | d7a5583 | tuning | MIT | Paul Henschel |
| koajs/koa | 824c1cf | tuning | MIT | Koa contributors |
| honojs/hono | f23b146 | tuning | MIT | Yusuke Wada and Hono contributors |
| fastify/fastify | 19d5be0 | holdout | MIT | The Fastify team |
| axios/axios | 2426e03 | holdout | MIT | Matt Zabriskie & Collaborators |
| colinhacks/zod | 004d800 | holdout | MIT | Colin McDonnell |
| typicode/json-server | 89a34a4 | holdout | MIT | typicode |
| excalidraw/excalidraw | ed10ac7 | holdout | MIT | Excalidraw |
| TanStack/query | 782b2e6 | holdout | MIT | Tanner Linsley |
| facebook/create-react-app | 6254386 | holdout | MIT | Facebook, Inc. |

Only each repository's root licence was read. Licences of individual packages inside the monorepos, and of code those projects bundle, were not checked.

## Questions and reference labels

The questions, the expected evidence for each, and the claim-support labels (`src/benchmark/dataset/v2/`) were written by the project owner. They are **owner-supplied reference labels, not independent ground truth**: nobody else has reviewed them. Figures that depend on them ("cites expected evidence", "correct", reference-match share) inherit that limit.

The holdout split is frozen (`freeze.lock.json`) and has not been run with a real model.

## Evidence contracts

Results are only comparable when produced under the same evidence contract (`EVIDENCE_CONTRACT` in `src/answer/validate.ts`).

| Contract | Rule | Result files |
|---|---|---|
| 1 | A claim listed evidence ids and one optional quote, accepted if it occurred in any cited block | `phase3/answers.groq.run-0.3-0.5{,-B,-C}.tuning.json`, summarised in `phase4b-tuning-abc.md` |
| 2 | Each piece of evidence is one id with its own quote, which must occur in that block. A quote over 400 characters makes the reply malformed | `phase3/answers.groq.run-0.3-0.5-{A,B,C,D}-e2.tuning.json` and `…-E-e2-v3.tuning.json`, all complete (32/32). A is preserved model output re-validated after the `quote-too-long` correction, not a fresh run; the others are actual runs |
| 3 | As 2, except that a quote over 400 characters is checked in full and then kept shortened | `phase3/answers.groq.run-0.3-0.5-{A,B,C,D}-e3.tuning.json` and `…-E-e3-v3.tuning.json`: the same replies validated again, with no model call |

A file name ending in `-v3` is a run on "version 3 evidence" (the application also reads importers and entry points from its index); it is not comparable case for case with the others.

## Reading order

- `phase1-report.md` to `phase4-report.md`: how ingestion, retrieval, evidence assembly and validation were built and measured, mostly without a model.
- `phase4b-tuning-abc.md`: three prompt variants with a real model: the contract 1 runs (historical) and the final contract 2 table (addenda at the end). No winner is established.
- `gate5-evidence-gap-audit.md`: what a partial owner review and an assistant reading found wrong with the claims, and why.
- `phase4b-tuning-D.md`, `route2-benchmark-v3-design.md`, `phase4b-tuning-E-v3.md`: a stricter prompt, the design for reading facts from the index, and the one run made with it.
- `phase4b-contract3-revalidation.md`: the change to the rule on quote length and the re-validation of the stored runs.
- `phase4b-adversarial-plan.md`: what adversarial testing covers and what has not been run.
- `audit/`: reviews of security, the interface, resources, retrieval and deployment, with what was fixed and what was not.

## About commit hashes

The reports cite short commit hashes. They refer to the private development history. This repository is published as a snapshot without that history, because an early commit contained excerpts of third-party source without their notices; the hashes are kept in the text as a record of order, not as links.
