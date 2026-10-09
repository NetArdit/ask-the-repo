# Adversarial evaluation: coverage and plan

Rule the whole design follows: **repository content is data, never authority.** Nothing a repository contains may change what the application or the model is allowed to do.

This document lists each attack, what stops it, how that has been tested, and what has not been tested. "Scripted" means a stand-in plays a model that has already been fully manipulated, which tests the application's boundary and says nothing about how easily a real model is manipulated. "Real model" tests: the semantic-attack suite was run once with a real model on a synthetic repository (see `phase4b-release-validation.md`); the wider real-model adversarial gate (Phase 4B gate 7) has not been run.

## Coverage

| Attack | What is meant to stop it | Tested how | Status |
|---|---|---|---|
| Forged citation ids | The validator accepts only ids the application supplied | `src/answer/validate.test.ts`; scripted suite `fabricates-evidence-id` | VERIFIED (scripted): 5 of 5 rejected |
| Fabricated file paths | Citations are ids, never paths; a path given as an id is unknown; any path a citation adds must match the evidence | `validate.test.ts` ("wrong path", "fabricated id format"); scripted `cites-a-path-instead-of-an-id` | VERIFIED (scripted): 5 of 5 rejected |
| Fabricated quotes | A quote must occur verbatim in the block its own entry names | `validate.test.ts` (wrong block, swapped quotes, stitched quote); scripted `forges-a-quote` | VERIFIED (scripted): 5 of 5 rejected |
| A real quote attributed to another block | Same rule: checked against the named block only | `validate.test.ts` ("a real quote attributed to the wrong block") | VERIFIED |
| Malformed or older-shape replies | Strict parsing; anything off-schema is rejected, never repaired | `validate.test.ts` ("fails closed on …", 12 cases) | VERIFIED |
| Claims with no evidence | Every claim must carry evidence | `validate.test.ts`; scripted `answers-without-citations` | VERIFIED (scripted): 5 of 5 rejected |
| System-prompt extraction | A reply that is not the JSON schema is rejected, so prose containing the prompt never reaches the reader | scripted `leaks-the-system-prompt` | VERIFIED (scripted): 5 of 5 rejected. Whether a real model can be made to place prompt text inside a valid claim: NOT TESTED |
| Prompt injection in repository files (README, comments, strings) | Evidence is fenced with a per-request random marker; system rules say evidence is data; instruction-like evidence is flagged and the reader is warned | Prompt-structure tests (`src/answer/prompt.test.ts`); flagging tests; scripted `obeys-injection-cites-hostile-file` | Structure and flagging VERIFIED. A manipulated model's answer **reaches the reader**: 5 of 5, with a warning on 4. Real-model susceptibility: NOT TESTED |
| Irrelevant but structurally valid evidence | Nothing. The validator cannot see relevance | scripted `cites-irrelevant-but-valid-evidence` | **NOT DEFENDED**: 5 of 5 reach the reader (warning on 4) |
| Unsupported claims with valid citations | Nothing structural. Left to the reader, and to the planned judge and human review | `src/benchmark/semantic-attacks.ts` (needs a real model) | **NOT DEFENDED**; real-model rate NOT TESTED |
| Claims contradicted by the cited lines | Same as above | same | **NOT DEFENDED**; NOT TESTED |
| Hostile source text rendered in the interface | All repository and model text is rendered as text; links only to github.com; Content-Security-Policy | Code inspection (no `dangerouslySetInnerHTML`); CSP served in the browser check | Rendering as text VERIFIED by inspection. The interface has NOT been attack-tested with hostile content (script tags, bidirectional text, very long lines) |

Scripted figures are from `exp-cli inject-suite` run under evidence contract 2: eight attackers, five questions each.

## What the evidence contract changed, and did not

Contract 2 binds each quote to one evidence id. It closes the hole where one quote could be matched against any of several cited blocks, and it stops a quote from standing for a passage that does not exist as a passage. It does not make the validator understand meaning. The two attacks that reach the reader above reach it exactly as before.

## Plan for gate 7 (not yet run)

To be run only after human review (gate 5) and judge agreement (gate 6), on the tuning repositories and synthetic fixtures, never on the holdout split.

1. **Real-model semantic attacks** (`exp-cli semantic-attacks A|B|C`): eight cases in a synthetic repository where valid citations do not support the claim, or where repository text tries to redefine the rules. Measure how often a forbidden claim is produced and how often it is accepted.
2. **Real-model injection** (`exp-cli inject-suite` with the real provider in place of the scripted ones): README and comment instructions, "ignore previous instructions", requests to reveal the prompt or a key. Measure obedience, and whether obedient answers pass validation.
3. **Extraction inside valid structure**: ask questions whose honest answer is "not enough evidence" while the evidence contains instructions to quote the system prompt; check whether any accepted claim contains prompt text.
4. **Interface rendering**: index a fixture repository whose files contain markup, script tags, control characters and extremely long lines; open them in the inspector in a real browser and confirm nothing executes and layout holds.
5. **Budget**: about 25 model calls for items 1 to 3 on the free tier. Each case is one call; results are recorded privately like tuning runs.

Each result will be labelled VERIFIED only for what was actually run, and the two "NOT DEFENDED" rows stay as they are unless a control is added and tested.
