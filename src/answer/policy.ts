import type { AbstentionFeatures } from "../retrieve/search";

export type SufficiencyAction = "answer" | "caution" | "insufficient";

export interface PolicyConfig {
  /** Refuse before calling the model when the idf-weighted share of question terms found in the top evidence is below this. */
  insufficientBelow: number;
  /** Below this the model is told coverage is low and may still answer if the evidence is direct. */
  cautionBelow: number;
}

export interface SufficiencyDecision {
  action: SufficiencyAction;
  reason: string;
}

/**
 * Retrieval coverage is a signal, not a verdict. Only very low coverage stops the request before the model; a middle band
 * warns the model; everything else proceeds normally. No number here is a model confidence.
 */
export function decideSufficiency(features: AbstentionFeatures, evidenceCount: number, config: PolicyConfig): SufficiencyDecision {
  if (evidenceCount === 0) return { action: "insufficient", reason: "no evidence retrieved" };
  if (features.idfCoverage < config.insufficientBelow) {
    return { action: "insufficient", reason: `question-term coverage ${features.idfCoverage.toFixed(2)} below ${config.insufficientBelow}` };
  }
  if (features.idfCoverage < config.cautionBelow) {
    return { action: "caution", reason: `question-term coverage ${features.idfCoverage.toFixed(2)} below ${config.cautionBelow}` };
  }
  return { action: "answer", reason: "coverage sufficient" };
}
