# Gate 5: what the owner found, the evidence gaps behind it, and a draft variant D

Date: 2026-10-09. No model was called to write this. No prompt, validator, retrieval, benchmark, label or recorded output was changed.

## Status

**Gate 5 is not passed and not complete.** Its outcome so far is: reviewed in part by the owner (the beginning of variant A's file), with partial and unsupported claims found. The owner's overall words for what they read were "not that bad", with a request to make it better.

What the owner said, translated from Albanian: "From my verification they are PARTIAL and UNSUPPORTED, so do the work better. I want the description to be complete, full and detailed."

What is **not** recorded: which claims the owner read and a verdict for each. `reports/private/review/labels-template.csv` is still 0 of 65. This report does not fill those in. Everything in the tables below is an assistant reading (single pass, 2026-10-07, `reports/private/gate5-evidence/`), kept apart from the owner's statement.

The owner's judgement is stricter than that assistant reading's headline (55 plausible, 10 partial) but agrees with its own notes: 27 of the 65 claims carry a stated "missing evidence", and 41 a stated ambiguity. The 27 are listed here.

## The gaps, by pattern

"Shown" is what the cited lines establish. "Not shown" is what the claim says beyond that. The last column is what would close the gap: more evidence, or a narrower claim.

### 1. A call is cited, the definition is not, and behaviour is taken from a name (15 claims)

| Claim | Shown | Not shown | What would close it |
|---|---|---|---|
| ky-1/A/1, ky-1/B/1, ky-1/C/1 | The retry routine calls a method named for calculating the retry delay and caps the result. | How the delay is calculated: the method's body is not in the evidence. | The method's definition in the evidence. Or the narrower claim: "the delay is obtained by calling that method; its body is not in the evidence." |
| ky-1/A/2 | A documented default backoff formula, and that retry-timing headers matter for some status codes. | That the method chooses between headers and the default. | The method's body. Or drop the sentence about how it chooses. |
| commerce-1/A/1, commerce-1/B/1 | The route file exports a POST handler that returns the result of a function imported from the shop library. | What that function does. | Narrow enough already in B; in A, the imported function's body if "revalidate" is to be described. |
| commerce-3/B/1, commerce-3/C/1 | The order of calls in the form action, the variant check, the cart call and the cache tag update. | That the first call is an "optimistic" update (taken from its name), and the button that triggers it. | The hook's definition. Or say "calls X, then Y" without characterising X. |
| react-6/A/1, react-6/B/1, react-6/C/1 | A call that commits the root, with a comment saying so, followed by that function's definition. | The enclosing function and the condition "after rendering finishes". | The lines above the call. Or "the commit starts at this call", without the "after rendering" clause. |
| koa-5/A/3, koa-5/C/4 | The composed middleware is run, then a responder on success and an error callback on failure. | What the responder and the error callback do; that the error reaches the application's handler. | Their definitions. Or name the calls without describing their effect. |
| koa-5/B/2, koa-5/C/2 | The middleware array is passed to a compose function inside the callback. | What compose returns. | Its definition. Or "passes the array to compose". |

### 2. "Which files or modules ...?" answered with a list the lines cannot show to be complete (8 claims)

| Claim | Shown | Not shown | What would close it |
|---|---|---|---|
| ky-6/A/1 | One module imports the error class. | The other importers (the owner's reference lists two more). | All importers in the evidence. The index's import graph already holds them. |
| commerce-8/A/1, commerce-8/B/1 | Two files import the function. | That no other file does. B words it as "the files that import", an exhaustive claim. | The importer list from the index. Or "among the evidence provided, these two import it". |
| vite-6/A/1, vite-6/B/1 | One file contains CSS processing functions. | Whether other files do; the question asks "which files". | More files in the evidence, or the qualifier above. |
| zustand-4/A/1 | One module imports the vanilla module. | The other importer the reference lists. | As for ky-6. |
| koa-3/A/1, koa-3/B/1 | Three modules import the helper. | That there is no fourth. | As for commerce-8. |

### 3. "The entry point is ..." without the declaration that makes it so (3 claims)

| Claim | Shown | Not shown | What would close it |
|---|---|---|---|
| express-2/A/1 | The top-level file re-exports the library module. | That the package declares it as its entry (package manifest not cited). | The manifest's `main`/`exports` in the evidence. |
| react-4/A/1, react-4/B/1 | The file exists; the cited lines are a header and type exports. In B the quote is a bare comment opener. | That it is the entry point, and what it exports at run time. | The manifest, or the file's export statements. As cited, the honest answer is `insufficient_evidence`. |

### 4. Outside knowledge (1 claim)

| Claim | Shown | Not shown | What would close it |
|---|---|---|---|
| vite-10/A/1 | A comment that some preprocessing logic was copied from another package. | That the compiler "lives in" that external package. | Nothing in this repository can show it; the claim should not be made (rule 1 of the prompt already forbids it). |

That is 15 + 8 + 3 + 1 = 27. Two of them, commerce-8/B/1 and vite-6/B/1 in pattern 2, also have a quote problem the validator already caught (`quote-mismatch`).

## Where the gaps come from

1. **Evidence that never reached the model.** Patterns 1, 2 and 3 are mostly this: the retrieved excerpts held the call but not the definition, some importers but not all, the file but not the manifest. No wording of the prompt can make the model cite lines it was not given. For "who imports X" the index already has the answer as data.
2. **Claims wider than their quote.** Given such evidence, the model still wrote "is calculated by", "the files that import", "the entry point". Variant C's rule ("state only the part the evidence shows") reduced this but did not remove it (C: 2 partial of 20 in the assistant reading).
3. **The validator cannot see either.** It checks that the id is real and the quote occurs in the block. That limit is documented and unchanged.

## What the owner asked for, and what can honestly be promised

The owner wants answers that are complete and detailed, and suggested "65 of 65".

- A count of 65 of 65 on these same claims is not a goal this project can pursue: reaching it by relabelling, by editing recorded outputs, or by tuning until this one set looks right would defeat the measurement. A, B and C stay as recorded.
- What can be done is to change the system and measure again. A new run produces a different set of claims, so the figure to watch is the share of claims an owner review finds supported, on the tuning split first and on the untouched holdout last.
- "Complete and detailed" and "every claim supported" pull against each other while the evidence is thin. A stricter prompt alone makes answers **narrower and more often `insufficient_evidence`**, not fuller. Fuller answers need better evidence (item 1 above), which is a retrieval change.

## Draft variant D (UNAPPLIED, NOT EVALUATED, not a winner)

A new variant under evaluation contract 2. A, B and C are untouched. Unlike B and C it is not a single-factor change from A: it combines C's entailment rule and B's `unsupported` field with three scoping rules aimed at patterns 1 to 3. That makes it a candidate to compare against C, not a controlled experiment against A.

Text that would replace rule 6 and renumber the reply rule to 8:

> 6. A claim must say only what its quoted lines show. If the lines show a call to something but not its definition, say that it is called; do not say what it does or how. If the question asks which or where and you list instances, list every one the evidence shows and say the list covers the evidence provided; never state or imply that it is complete. Call a file an entry point only when the evidence includes the declaration that makes it one. If the evidence shows only part of what you would like to say, state that part or leave the claim out. If no claim survives, return insufficient_evidence.
> 7. If part of the question asks about something the evidence does not show, do not guess: list it in an optional "unsupported" array of short strings (at most 5).

Expected effect, to be tested rather than assumed: fewer over-wide claims in patterns 1 to 3; more `insufficient_evidence`; answers no more complete than today.

Files it would touch if approved: `src/answer/prompt.ts` (add `D` to `PromptVariant`, `parsePromptVariant` and `SYSTEM_PROMPTS`) and its tests. Cost of one tuning run: 32 model calls on the free tier, zero money. A run needs the owner's go-ahead for the calls.

## The larger lever (needs a new benchmark version; not proposed for now)

- Answer "which modules import X" from the index's import graph, and give the model the definition of a function when its call is retrieved, and the package manifest for entry-point questions.
- Let a claim rest on more than one quote where it needs to.

Either changes retrieval or the evaluation contract, so results would not be comparable with A, B and C and the benchmark would need a new version, with the owner's approval.

## Still needed from the owner

Which claims were read, and the verdict for each (`SUPPORTED`, `PARTIAL`, `UNSUPPORTED`, `CONTRADICTED`), in `reports/private/review/labels-template.csv` or told to the executor to record. Without that, Gate 5 has a finding but no per-claim record.
