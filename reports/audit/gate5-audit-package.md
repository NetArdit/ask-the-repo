# Gate 5 audit package (technical consistency only)

Prepared for the project gatekeeper. This checks that the review package is internally consistent. It is not Gate 5: no claim has been reviewed by a person, and the reference labels are owner-supplied, not independent ground truth.

## What was checked (programmatic, no model call)

| Check | A | B | C |
|---|---|---|---|
| Result records / unique / equal to the 32 tuning specs | 32 / 32 / yes | 32 / 32 / yes | 32 / 32 / yes |
| Holdout case IDs present | 0 | 0 | 0 |
| Claims in the result records | 24 | 21 | 20 |
| Rows in `labels-template.csv` | 24 | 21 | 20 |
| Duplicate claim rows | 0 | 0 | 0 |
| Cases in `review-<variant>.md` (unique) | 32 | 32 | 32 |
| Private raw records (unique), all contract 2, one prompt variant | 32 | 32 | 32 |
| Provider failures / provider_error records / halted | 0 / 0 / no | 0 / 0 / no | 0 / 0 / no |

Total claim rows: 65 (file rows: 65). Package location: `reports/private/review/` (git-ignored). The README and each review file state: Gate 5 not started, owner-supplied labels, structural validity is not semantic support, A is a deterministic revalidation and not a fresh run, B and C are actual runs, one run per variant, zero holdout calls, no winner.

## Evidence the reviewer should know about (offline analysis of stored replies)

- Quote lengths in the accepted claims: A 35 quotes (shortest 33 characters), B 29 (shortest 3: `/**`), C 25 (shortest 26). Across 89 accepted quotes one is under 20 characters. The weak minimum-length rule (3 characters, finding T-08) was exercised once, in B.
- If the minimum were raised, B would lose at most that one quote's claim; A and C would be unchanged. Any such change is an evidence-contract change and would need a version bump, which is a gatekeeper decision.
- Rejection codes: A 2 quote-too-long + 1 quote-not-in-citation; B 3 + 3; C 3 quote-too-long.
