import type { PolicyConfig } from "./policy";

/** Chosen on the tuning split of the answer evaluation (see reports/phase3-report.md); applied once to the frozen holdout. */
export const DEFAULT_POLICY: PolicyConfig = { insufficientBelow: 0.3, cautionBelow: 0.5 };

/**
 * "Version 3 evidence": what the answer pipeline adds to the retrieved blocks, for evaluation runs, the zero-call check and
 * the application alike. Changes 2 and 3 of reports/route2-benchmark-v3-design.md: importers read from the index's import
 * table, and a package's entry points with the manifest lines that declare them. Change 1 (definitions alongside call sites)
 * exists but is left out: its own check showed 19 added blocks for one more needed definition.
 */
export const V3_EVIDENCE = { importerEvidence: { maxBlocks: 4 }, entryEvidence: { maxBlocks: 2 } } as const;

/**
 * What the web application runs: version 3 evidence, prompt E, evidence contract 3. This is the owner's choice for the
 * demonstration, made on one tuning run of that configuration (reports/phase4b-tuning-E-v3.md, re-validated under contract 3
 * in reports/phase4b-contract3-revalidation.md) on questions the changes were designed against. It is not a variant selected
 * by the evaluation method: the holdout has not been run. To go back to what the application ran before, make this `{}`.
 */
export const APP_ANSWER_SETTINGS = { ...V3_EVIDENCE, promptVariant: "E", evidenceContract: 3 } as const;
