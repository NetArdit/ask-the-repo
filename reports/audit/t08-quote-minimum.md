# T-08: the quote minimum (analysis only; nothing was changed)

## Facts
- `quoteIsVerbatim` (`src/answer/validate.ts`) accepts a quote if, after removing `L12|` prefixes and collapsing whitespace, it is at least 3 characters long and occurs as a continuous substring of the normalised text of the one block its entry names. There is no minimum beyond 3 characters, no token-boundary rule, and no check that the quote bears on the claim.
- Measured over all accepted quotes in the three tuning runs (from the private raw replies, no model call): A 35 quotes, shortest 33 characters; B 29 quotes, shortest 3 (`/**`); C 25 quotes, shortest 26. One of 89 is under 20 characters.
- The accepted configuration for the held-out contract is unchanged: 400-character maximum.

## What the contract guarantees today
- Every evidence id is one the application issued for this question and commit, so a citation cannot point to a fabricated path, line range, repository or commit.
- Each quote occurs in the block that citation names, and not only in some other block. A quote stitched across blocks fails.
- Every claim has at least one citation with a quote; malformed output fails closed.

## What it does not guarantee
- That the quote bears on the claim. This is semantic, not structural: even a 200-character quote that exists in the block can be irrelevant to the claim.
- That a short quote identifies a place. Strings such as `/**`, `the`, `=>` or `return` occur in almost any code block, so the quote check then adds almost nothing beyond "the id is real". The 3-character minimum makes the weakest case the cheapest one for a manipulated or careless model.

## Risk
- Structural versus semantic: the weakness is in the structural provenance check (it can be satisfied trivially), but what it fails to protect is semantic grounding. Tightening it narrows the gap a little; it does not close it.
- Exploitability: not exploited in the data. 88 of 89 accepted quotes are 20 characters or longer. In B, `react-4/B/1` quoted `/**`; the assistant reading rated that claim partial (the cited lines do not show the entry point). A model that wanted to pass the check with unrelated evidence could do so with such a quote, so the weakness is real but exercised once.
- Instruction-injection exposure: unchanged by this; hostile repository text can only affect which blocks the model chooses to cite.

## Impact of tightening
- Any change to the minimum changes the accepted set, so it is an evidence-contract change: `EVIDENCE_CONTRACT` would be bumped, and A, B and C would no longer be comparable with the present results without regeneration or revalidation.
- Deterministic revalidation would suffice for the existing replies (no new model calls), as was done for the `quote-too-long` correction. At a minimum such as 12 non-space characters, from the measured quotes only B's `/**` quote would be rejected, which would change `react-4/B/1` from cited to rejected and B's counts by one case; A and C would not change.
- Alternative with no contract change: expose quote length in the validated claim and let the UI mark very short quotes as weak provenance.

## Options
1. Leave as is, and document the limit (cheapest; the weakness stays).
2. Tighten to a minimum number of non-space characters or a whole-token or whole-line rule, bump the contract, revalidate A/B/C deterministically (no Groq quota), report that B changes by one case.
3. UI-only: show quote length and flag very short quotes, with no contract change.
4. Add a semantic judge (Gate 6 territory; needs reviewed labels; costs quota).

## Recommendation
Option 3 now (reversible, no methodology impact), and put Option 2 to the gatekeeper with the measured effect (one quote in one variant), to be decided together with Gate 5 so that a version bump happens once. Do not start Option 4 before reviewed labels exist.
