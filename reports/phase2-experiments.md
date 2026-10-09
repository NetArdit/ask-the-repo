# Phase 2 experiment results

Aggregate retrieval metrics (positives only). Control = Phase 1 retrieval on the Phase 2 dataset.

### tuning

| run | n | hit@1 | hit@3 | hit@5 | hit@10 | MRR | p@5 | median ms |
|---|---|---|---|---|---|---|---|---|
| control | 74 | 36% | 47% | 55% | 64% | 0.44 | 0.16 | 1.0 |
| demote-70 | 74 | 43% | 55% | 65% | 69% | 0.51 | 0.20 | 1.0 |
| demote-50 | 74 | 47% | 57% | 66% | 72% | 0.54 | 0.22 | 1.1 |
| demote-30 | 74 | 47% | 58% | 68% | 74% | 0.55 | 0.23 | 0.9 |
| config-index | 74 | 50% | 64% | 74% | 81% | 0.59 | 0.25 | 0.9 |
| entry-boost | 74 | 51% | 62% | 73% | 81% | 0.59 | 0.26 | 2.1 |
| entry-boost-12 | 74 | 50% | 62% | 74% | 82% | 0.59 | 0.26 | 1.0 |
| entry-boost-20 | 74 | 51% | 62% | 73% | 82% | 0.60 | 0.25 | 1.0 |
| stem-verb | 74 | 51% | 64% | 73% | 81% | 0.60 | 0.26 | 1.0 |
| import-resolution | 74 | 50% | 64% | 74% | 82% | 0.59 | 0.26 | 1.3 |
| flow-fallback | 74 | 51% | 65% | 77% | 84% | 0.61 | 0.26 | 0.9 |
| accepted-v1 | 74 | 51% | 66% | 77% | 84% | 0.61 | 0.27 | 1.2 |
| accepted | 74 | 53% | 68% | 78% | 84% | 0.62 | 0.27 | 1.0 |

### holdout

| run | n | hit@1 | hit@3 | hit@5 | hit@10 | MRR | p@5 | median ms |
|---|---|---|---|---|---|---|---|---|
| control | 69 | 41% | 55% | 64% | 68% | 0.49 | 0.18 | 1.5 |
| demote-30 | 69 | 43% | 65% | 77% | 80% | 0.56 | 0.25 | 1.6 |
| config-index | 69 | 45% | 67% | 77% | 81% | 0.58 | 0.25 | 1.7 |
| entry-boost-12 | 69 | 49% | 70% | 80% | 83% | 0.61 | 0.26 | 1.9 |
| stem-verb | 69 | 52% | 67% | 78% | 84% | 0.62 | 0.26 | 1.8 |
| import-resolution | 69 | 49% | 72% | 81% | 84% | 0.62 | 0.27 | 2.0 |
| flow-fallback | 69 | 49% | 70% | 80% | 81% | 0.61 | 0.26 | 2.1 |
| accepted-v1 | 69 | 49% | 72% | 81% | 83% | 0.62 | 0.27 | 2.1 |
| accepted | 69 | 49% | 72% | 81% | 83% | 0.62 | 0.27 | 2.4 |

fixture control: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(README.md) adv-5=FAIL(src/auth/login.ts)

fixture demote-70: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture demote-50: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture demote-30: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture config-index: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture entry-boost: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture entry-boost-12: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture entry-boost-20: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture stem-verb: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture import-resolution: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture flow-fallback: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture accepted-v1: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)

fixture accepted: adv-1=pass(src/auth/login.ts) adv-2=pass(src/payments/stripe.ts) adv-3=FAIL(README.md) adv-4=FAIL(src/evil.ts) adv-5=FAIL(src/auth/login.ts)
