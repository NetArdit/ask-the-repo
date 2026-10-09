export type FileClass = "source" | "test" | "example" | "docs" | "config";

const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__", "spec", "specs", "e2e", "fixtures", "fixture", "test-d", "test-helpers", "__snapshots__"]);
const EXAMPLE_DIRS = new Set(["examples", "example", "demo", "demos", "playground", "playgrounds", "samples", "sample", "benchmarks", "benchmark", "bench", "scripts"]);
const DOCS_DIRS = new Set(["docs", "doc", "dev-docs", "documentation"]);

/** Deterministic, path-only classification used to demote (never delete) evidence that is rarely the answer to "where is X implemented". */
export function classifyFile(filePath: string, isConfig: boolean): FileClass {
  if (isConfig) return "config";
  const segments = filePath.split("/");
  const base = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1);
  if (dirs.some((d) => TEST_DIRS.has(d)) || /\.(test|spec)\.[a-z]+$/i.test(base) || /^test[-_.]/i.test(base)) return "test";
  if (dirs.some((d) => EXAMPLE_DIRS.has(d) || d.startsWith("template-"))) return "example";
  if (dirs.some((d) => DOCS_DIRS.has(d)) || /\.mdx?$/i.test(base)) return "docs";
  return "source";
}

/** A question that names tests, examples or docs wants that kind of file, so demotion is skipped for it. */
export function questionWantsNonSource(question: string): boolean {
  return /\b(tests?|specs?|examples?|demos?|samples?|docs?|documentation|readme|guide|tutorial|template)\b/i.test(question);
}
