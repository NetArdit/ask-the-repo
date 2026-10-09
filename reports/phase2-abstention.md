
#### Task A: abstain when the repository has no answer (negatives)

tuning: 8 should-abstain of 82; holdout: 7 of 76

| rule | threshold (chosen on tuning) | tuning confusion | bal.acc | holdout confusion | bal.acc |
|---|---|---|---|---|---|
| topScore < t | 1.1 | TP 7 / FN 1 / FP 16 / TN 58 | 83% | TP 6 / FN 1 / FP 13 / TN 56 | 83% |
| idfCoverage < t | 0.5 | TP 8 / FN 0 / FP 20 / TN 54 | 86% | TP 7 / FN 0 / FP 12 / TN 57 | 91% |
| top1Coverage < t | 0.35 | TP 7 / FN 1 / FP 19 / TN 55 | 81% | TP 7 / FN 0 / FP 14 / TN 55 | 90% |
| margin < t | 0.1 | TP 6 / FN 2 / FP 24 / TN 50 | 71% | TP 4 / FN 3 / FP 27 / TN 42 | 59% |
| no structural support and top1Coverage < t | 0.5 | TP 7 / FN 1 / FP 17 / TN 57 | 82% | TP 6 / FN 1 / FP 14 / TN 55 | 83% |
| idfCoverage < a OR topScore < b | 0.5, 0.3 | TP 8 / FN 0 / FP 20 / TN 54 | 86% | TP 7 / FN 0 / FP 12 / TN 57 | 91% |

#### Task B: abstain when the evidence would not support an answer (negatives + retrieval misses at top-5)

tuning: 24 should-abstain of 82; holdout: 20 of 76

| rule | threshold (chosen on tuning) | tuning confusion | bal.acc | holdout confusion | bal.acc |
|---|---|---|---|---|---|
| topScore < t | 1.3 | TP 17 / FN 7 / FP 16 / TN 42 | 72% | TP 16 / FN 4 / FP 16 / TN 40 | 76% |
| idfCoverage < t | 0.35 | TP 12 / FN 12 / FP 7 / TN 51 | 69% | TP 12 / FN 8 / FP 5 / TN 51 | 76% |
| top1Coverage < t | 0.35 | TP 14 / FN 10 / FP 12 / TN 46 | 69% | TP 13 / FN 7 / FP 8 / TN 48 | 75% |
| margin < t | 0.1 | TP 14 / FN 10 / FP 16 / TN 42 | 65% | TP 12 / FN 8 / FP 19 / TN 37 | 63% |
| no structural support and top1Coverage < t | 1.01 | TP 18 / FN 6 / FP 18 / TN 40 | 72% | TP 15 / FN 5 / FP 17 / TN 39 | 72% |
| idfCoverage < a OR topScore < b | 0.35, 0.3 | TP 12 / FN 12 / FP 7 / TN 51 | 69% | TP 12 / FN 8 / FP 5 / TN 51 | 76% |
