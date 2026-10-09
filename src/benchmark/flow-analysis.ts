import { parseRepoRef } from "../github/repo-ref";
import { DEFAULT_LIMITS, ingestTarGz } from "../ingest/tarball";
import { getParser } from "../parse/languages";
import { ensureTarball, openCachedTarball } from "./cache";
import { classifyFile } from "../retrieve/file-class";
import { loadRepos } from "./dataset";

/** First-match classification of the source line an ERROR node starts on. Order matters. */
const SYNTAX_CLASSES: [string, RegExp][] = [
  ["import/export type", /^\s*(import|export)\s+(type|typeof)\b/],
  ["opaque/declare/type alias", /^\s*(export\s+)?(declare\s+|opaque\s+)?type\s+[A-Za-z_$]/],
  ["interface/declare", /^\s*(export\s+)?(declare|interface)\s/],
  ["exact object type {| |}", /\{\||\|\}/],
  ["maybe type (?T)", /[:(,]\s*\?[A-Za-z_$\[{]/],
  ["generic call/params <T>", /[A-Za-z_$)]<[A-Za-z_$][^>]*>\s*\(/],
  ["type annotation", /[A-Za-z_$\])]\??:\s*(\$|[A-Z{\[]|string\b|number\b|boolean\b|any\b|void\b|mixed\b|null\b)/],
  ["type cast ((x: T))", /\(\s*[\w.$\[\]()]+\s*:\s*[^)]+\)/],
  ["class field type", /^\s+(static\s+)?[A-Za-z_$]+\??:\s/],
  ["%checks / predicate", /%checks/],
];

function classify(line: string): string {
  for (const [name, re] of SYNTAX_CLASSES) if (re.test(line)) return name;
  return "other";
}

export interface FlowAnalysis {
  repo: string;
  jsFiles: number;
  withErrors: number;
  withFlowPragma: number;
  errorsWithPragma: number;
  /** Files with parse errors / all JS files, by path class (source, test, example, docs). */
  byFileClass: Record<string, { files: number; withErrors: number }>;
  firstErrorClass: Record<string, number>;
  allErrorClass: Record<string, number>;
  samples: Record<string, string[]>;
  tsxFallback: { cleaner: number; clean: number; notBetter: number };
}

const FLOW_PRAGMA = /@flow\b/;

/** Why does Tree-sitter's JavaScript grammar fail on this repository, and would the TSX grammar already parse that syntax? */
export async function analyzeFlow(repoName: string): Promise<FlowAnalysis> {
  const repo = loadRepos().find((r) => r.repo === repoName);
  if (!repo) throw new Error(`unknown repo ${repoName}`);
  const tarball = await ensureTarball(parseRepoRef(repo.repo), repo.sha);
  const js = await getParser("javascript");
  const tsx = await getParser("tsx");
  const out: FlowAnalysis = {
    repo: repoName,
    jsFiles: 0,
    withErrors: 0,
    withFlowPragma: 0,
    errorsWithPragma: 0,
    byFileClass: {},
    firstErrorClass: {},
    allErrorClass: {},
    samples: {},
    tsxFallback: { cleaner: 0, clean: 0, notBetter: 0 },
  };
  await ingestTarGz(openCachedTarball(tarball), DEFAULT_LIMITS, ({ path, content, language }) => {
    if (language !== "javascript") return;
    const text = content.toString("utf8");
    out.jsFiles += 1;
    const pragma = FLOW_PRAGMA.test(text.slice(0, 2000));
    if (pragma) out.withFlowPragma += 1;
    const cls = classifyFile(path, false);
    const bucket = (out.byFileClass[cls] ??= { files: 0, withErrors: 0 });
    bucket.files += 1;
    const tree = js.parse(text);
    if (!tree) return;
    try {
      if (!tree.rootNode.hasError) return;
      out.withErrors += 1;
      bucket.withErrors += 1;
      if (pragma) out.errorsWithPragma += 1;
      const errors = tree.rootNode.descendantsOfType("ERROR").filter((n): n is NonNullable<typeof n> => n !== null);
      const lines = text.split("\n");
      errors.forEach((node, i) => {
        const line = lines[node.startPosition.row] ?? "";
        const cls = classify(line);
        out.allErrorClass[cls] = (out.allErrorClass[cls] ?? 0) + 1;
        if (i === 0) {
          out.firstErrorClass[cls] = (out.firstErrorClass[cls] ?? 0) + 1;
          const list = (out.samples[cls] ??= []);
          if (list.length < 3) list.push(`${path}:${node.startPosition.row + 1}: ${line.trim().slice(0, 110)}`);
        }
      });
      const alt = tsx.parse(text);
      if (alt) {
        try {
          const altErrors = alt.rootNode.descendantsOfType("ERROR").length;
          if (!alt.rootNode.hasError) out.tsxFallback.clean += 1;
          else if (altErrors < errors.length) out.tsxFallback.cleaner += 1;
          else out.tsxFallback.notBetter += 1;
        } finally {
          alt.delete();
        }
      }
    } finally {
      tree.delete();
    }
  });
  return out;
}
