# Route 2: design for benchmark version 3 (DESIGN ONLY, nothing implemented)

Date: 2026-10-09. No code, prompt, dataset, evaluator or result was changed to write this, and no model was called. Implementation is an owner decision and has not been approved.

## Why

The owner's Gate 5 review found partial and unsupported claims and asked for answers that are complete and detailed. `reports/gate5-evidence-gap-audit.md` traces 27 of the 65 reviewed claims to an evidence gap, in three patterns that account for 26 of them:

1. a call is retrieved but not the definition (15 claims);
2. "which modules import X" gets a list the lines cannot show to be complete (8 claims);
3. "the entry point is ..." without the declaration that makes it so (3 claims).

Variant D (Route 1) only narrows what the model may say about thin evidence. Route 2 changes what evidence the model is given. That is a retrieval change, so its results cannot be compared with A, B, C or D, and it needs a new benchmark version.

## What does not change

- **Evaluation contract 2**: one citation paired with one quote, quote at most 400 characters, quote verbatim from the cited block. A claim may already carry several such pairs, so no contract change is needed to rest a claim on two passages.
- The validator, the evaluator and the scoring.
- Benchmark version 2: its dataset folder, its freeze lock, its unrun holdout, and every recorded result and hash.
- Zero cost, one provider, one model.

## The key observation

The index already holds, as data, what the three patterns are missing (`src/index/types.ts`):

| Gap | Already in the index |
|---|---|
| Definition of a called function | `symbols`: file, name, kind, start line, end line |
| Who imports a name or a module | `imports`: importing file, specifier, resolved target file, line, imported names |
| Declared entry points | `entries`: file, entry kind (`main`, `module`, `bin`, `exports`, ...), package name |

So none of this needs a better search ranking. It needs the answer pipeline to pull the matching rows and fetch their lines.

## Measured: is the missing evidence really in the index?

`npx tsx scripts/evidence-coverage.ts`, read-only, no model call, tuning repositories only, 2026-10-09. For the 12 tuning cases behind the gap claims it looks up, in the cached index, the piece the audit says was missing.

| Pattern | Needed pieces found in the index | Cases with all of theirs |
|---|---|---|
| 1. definition behind a call | 8 of 9 | 4 of 5 |
| 2. who imports it | 4 of 5 | 4 of 5 |
| 3. declared entry point | 2 of 2 | 2 of 2 |
| Overall | **14 of 16** | **10 of 12** |

What the two misses are:

- koa-5: the error handler is a property of an object literal, not a declared function, so the symbol table has no row for it. Definitions of that shape would stay out of reach.
- vite-6: "which files implement CSS processing" is not an import relation. No table lists the answer; this case stays a retrieval question.

What the hits show beyond a yes:

- The definitions are there with line ranges, but some are long: 76 lines for the retry-delay method, 70 for the responder, and the function enclosing the commit call is 213 lines. A firm line limit is needed, as the risks below say.
- For "which modules import HTTPError" the index lists 14 files where the owner's reference lists 3: the other 11 are test files. So "the index lists N importers" needs a rule about tests, and the reference itself is narrower than the repository.
- For the other three importer questions the index list and the reference agree exactly.

This says the data exists. It does not say the model would use it well, or that an answer built on it would be supported; only a run and a reading can.

## Proposed changes, by gap

### Change 1: definitions alongside call sites (pattern 1)

- When an assembled evidence block contains a call to, or an import of, a name that the index resolves to a symbol in an indexed file, add that symbol's definition (start line to end line, cut to a line limit) as a further evidence block.
- One hop only, the most-referenced names first, inside the existing evidence budget.
- Touches: evidence assembly (`src/answer/evidence.ts`) and the structural expansion in `src/retrieve/search.ts`. Both are protected today.
- Effect on comparability: retrieval hit rates and every answer metric change.

### Change 2: importers from the import table (pattern 2)

- When the question asks which files or modules import a name or a module, take every `imports` row whose resolved target or imported names match, and add each importer's import line as an evidence block (the row carries the line number).
- The application, not the model, states how many importers the index lists, as a structure line in the prompt and as a note beside the answer. The model may quote each import line; it never has to assert completeness, which no quote can support.
- Honest wording: "the index lists N importers", not "all importers". Import resolution has known blind spots (dynamic imports, unresolved relative paths, aliases when alias resolution is off).
- Touches: a small question classifier (new), evidence assembly, the prompt builder (a new structure line), the answer view (the note). The system prompt needs one sentence explaining the structure line, so this is a new prompt variant as well.

### Change 3: the declaration behind an entry point (pattern 3)

- When the question asks for an entry point, add the lines of the package manifest that declare it, and the file's own export lines.
- The accepted configuration already indexes configuration files and fills `entries` (`src/retrieve/defaults.ts`: `includeConfig: true`), and search already boosts declared entry files. What is missing is that the manifest's declaring lines are not guaranteed to be among the evidence blocks. No index rebuild is needed.
- Touches: evidence assembly only.

### Change 4: the prompt on top

- Variant D's scoping rules stay useful: even with better evidence the model must not say more than its quotes show. Version 3 would carry D's text plus the sentence for the importer count. Decide after D's tuning result is read.

### Not proposed

- Trimming or enlarging the evidence budget for its own sake, changing tokenisation, stop words or scoring constants. The retrieval audit lists them; they are separate experiments.

## Artifacts affected

| Artifact | Version 2 | Version 3 |
|---|---|---|
| `src/benchmark/dataset/v2/` | unchanged, frozen | not used |
| `src/benchmark/dataset/v3/` | does not exist | new: copy of the question and answer files, with expected evidence given as line ranges where it is only a file today |
| Freeze lock | `v2/freeze.lock.json`, unchanged | new lock for v3 |
| Result and checkpoint file names | `...-e2...` | a version tag added, so a v3 run can never write into a v2 file (the existing naming test is extended) |
| Evidence assembly, structural retrieval | as is | changed behind a version switch that defaults to version 2 behaviour |
| Index artifacts and index configuration | as is | unchanged: the needed tables are already in the index |
| Evaluator, validator, contract | unchanged | unchanged |
| The web application | version 2 behaviour | switches to version 3 only after the owner accepts its results |

## Evaluation procedure

1. **Zero model calls first.** For each tuning case behind the 27 gap claims, check mechanically whether the missing lines named in the audit (the definition, the other importers, the manifest lines) are now inside the assembled evidence. This "evidence coverage" figure is the first result, and it is cheap to iterate on.
2. **Token check, zero model calls.** Measure prompt size per case. Today an answer costs about 4,000 tokens against a limit of 8,000 a minute. More evidence must stay under that, or the run cannot be paced.
3. **One tuning run** (32 calls) with the version 3 pipeline and its prompt. Same model, pacing, checkpointing, evaluator.
4. **Reading.** An assistant reading in the existing format, clearly labelled, and an owner review of a sample at least. The figure reported is the share of claims found supported, with the counts of `insufficient_evidence` and withheld answers beside it, so that narrowness cannot hide.
5. **Holdout last, once**, with `--final`, only on the owner's instruction.

What is reported: evidence coverage before and after, tokens per call, the answer table in the same shape as for A to D, the claim list, and the limits.

## Cost

- Money: zero.
- Model calls: 32 per tuning run; a holdout run later. Roughly one run a day on the free tier.
- Work: several days of implementation and tests. The classifier in change 2 is the larger part; change 3 is the smallest.

## Risks

- **Tuning to the questions.** A classifier that recognises "which modules import" can be written to fit the 32 tuning questions. It must be built from question forms, not from this list, and the holdout is the check.
- **Token limit.** Definitions can be long. Without a firm cut the per-minute limit fails every call.
- **False completeness.** "The index lists N importers" is only as good as import resolution. The wording must stay with what the index knows.
- **Evidence crowding.** Definitions, import lines and manifest lines compete with the search results for the same eight evidence slots and character budget; adding one can push out another that the answer needed.
- **More to maintain.** Two pipeline versions exist until version 2 is retired.

## Unresolved questions

1. Version 2's holdout has never been sent to a model. May version 3 use the same holdout questions as its own holdout, or must it draw new ones? Earlier phases computed retrieval metrics on the holdout; whether that disqualifies it for version 3 needs a ruling.
2. Does an application-stated fact ("the index lists 3 importers") count as part of the answer for scoring, or sit outside it?
3. Should the web application move to version 3 as soon as it is accepted, or keep version 2 until deployment?

## Owner decisions needed before any implementation

1. Approve benchmark version 3 at all, knowing results will not be comparable with A, B, C, D.
2. The holdout question above.
3. Whether to do all three changes or start with one. Change 1 (definitions) covers the most claims (15 of 27).
4. The quota: one model run a day for as many days as it takes.
