import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexConfig } from "../index/types";
import type { SearchOptions } from "../retrieve/search";
import { CONTROL_SPEC, type ExperimentSpec } from "./experiment";

interface Delta {
  description: string;
  index?: Partial<IndexConfig>;
  search?: SearchOptions;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Changes accepted so far, each decided by tuning + holdout evidence and recorded in ACCEPTED.md. New candidates are measured on top of these. */
function loadAccepted(): { index: Partial<IndexConfig>; search: SearchOptions } {
  return JSON.parse(readFileSync(path.join(DIR, "accepted.json"), "utf8")) as { index: Partial<IndexConfig>; search: SearchOptions };
}

/** One change per candidate. Parameter values are fixed here before any measurement. */
export const CANDIDATES: Record<string, Delta> = {
  "demote-50": { description: "Multiply fused score of test/example/docs chunks by 0.5 (skipped when the question asks about tests/examples/docs)", search: { classWeights: { test: 0.5, example: 0.5, docs: 0.5 } } },
  "demote-30": { description: "Same as demote-50 with factor 0.3", search: { classWeights: { test: 0.3, example: 0.3, docs: 0.3 } } },
  "demote-70": { description: "Same as demote-50 with factor 0.7", search: { classWeights: { test: 0.7, example: 0.7, docs: 0.7 } } },
  "config-index": { description: "Index package.json/tsconfig.json as documents (no entry-point logic)", index: { includeConfig: true } },
  "entry-boost": { description: "Config indexed + declared package entry points boosted for entry-point questions", index: { includeConfig: true }, search: { entryBoost: true } },
  "entry-boost-12": { description: "entry-boost with entry weight 1.2", index: { includeConfig: true }, search: { entryBoost: true, entryWeight: 1.2 } },
  "entry-boost-20": { description: "entry-boost with entry weight 2.0", index: { includeConfig: true }, search: { entryBoost: true, entryWeight: 2.0 } },
  "stem-verb": { description: "Also fold -ing/-ed verb forms at index and query time", index: { stemMode: "plural+verb" } },
  "import-resolution": { description: "Resolve workspace-package imports and tsconfig paths/baseUrl aliases", index: { includeConfig: true, resolveWorkspaceAndAliases: true } },
  "flow-fallback": { description: "Retry JS files that fail to parse with the TSX grammar and keep the cleaner tree", index: { parseVariant: "flow-tsx-fallback" } },
};

export function resolveSpec(name: string): ExperimentSpec {
  if (name === "control") return CONTROL_SPEC;
  if (name === "accepted") {
    const acc = loadAccepted();
    return { name, description: "Control plus all accepted changes", index: { ...CONTROL_SPEC.index, ...acc.index }, search: { ...CONTROL_SPEC.search, ...acc.search } };
  }
  const delta = CANDIDATES[name];
  if (!delta) throw new Error(`Unknown experiment ${name}`);
  const acc = loadAccepted();
  return {
    name,
    description: delta.description,
    index: { ...CONTROL_SPEC.index, ...acc.index, ...delta.index },
    search: { ...CONTROL_SPEC.search, ...acc.search, ...delta.search },
  };
}
