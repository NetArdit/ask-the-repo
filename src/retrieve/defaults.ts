import type { IndexConfig } from "../index/types";
import type { SearchOptions } from "./search";

/**
 * The retrieval configuration that survived the Phase 2 experiments (see src/benchmark/accepted.json, which the
 * benchmark reads; a test keeps the two identical). An index must be queried with the options it was built for.
 */
export const DEFAULT_INDEX_CONFIG: IndexConfig = {
  stemMode: "plural",
  includeConfig: true,
  parseVariant: "flow-tsx-fallback",
  resolveWorkspaceAndAliases: true,
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  classWeights: { test: 0.3, example: 0.3, docs: 0.3 },
  entryBoost: true,
  entryWeight: 1.2,
};
