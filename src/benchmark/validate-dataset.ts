import { parseRepoRef } from "../github/repo-ref";
import { countLines } from "../parse/chunk";
import { ensureTarball, openCachedTarball } from "./cache";
import { DEFAULT_LIMITS, ingestTarGz } from "../ingest/tarball";
import { loadQuestions, loadRepos, type BenchQuestion } from "./dataset";

export interface ValidationProblem {
  id: string;
  problem: string;
}

/**
 * Checks that every expected path exists among the indexable files of the pinned commit, that line ranges fit inside
 * the file, and that every negative question's absent terms really occur nowhere in the repository.
 */
export async function validateRepo(repo: string, sha: string, questions: BenchQuestion[]): Promise<ValidationProblem[]> {
  const ref = parseRepoRef(repo);
  const file = await ensureTarball(ref, sha);
  const lineCounts = new Map<string, number>();
  const absent = new Map<string, Set<string>>();
  const terms = new Set(questions.flatMap((q) => q.absentTerms ?? []));
  for (const t of terms) absent.set(t, new Set());
  await ingestTarGz(openCachedTarball(file), DEFAULT_LIMITS, ({ path, content }) => {
    const text = content.toString("utf8");
    lineCounts.set(path, countLines(text));
    const lower = text.toLowerCase();
    for (const t of terms) if (lower.includes(t)) absent.get(t)!.add(path);
  });
  // Configuration files are not source, but expected evidence may legitimately point at them.
  const problems: ValidationProblem[] = [];
  for (const q of questions) {
    for (const e of q.expected) {
      const lines = lineCounts.get(e.path);
      if (lines === undefined) {
        if (!/(^|\/)(package\.json|tsconfig\.json|next\.config\.[a-z]+)$/.test(e.path)) problems.push({ id: q.id, problem: `missing path ${e.path}` });
        continue;
      }
      if (e.lines && (e.lines[0] < 1 || e.lines[0] > lines)) problems.push({ id: q.id, problem: `${e.path}: line ${e.lines[0]} outside 1..${lines}` });
    }
    for (const t of q.absentTerms ?? []) {
      const hits = absent.get(t)!;
      if (hits.size > 0) problems.push({ id: q.id, problem: `absent term "${t}" occurs in ${[...hits].slice(0, 3).join(", ")}` });
    }
  }
  return problems;
}

export async function validateAll(): Promise<void> {
  const repos = loadRepos();
  const all = [...loadQuestions("tuning"), ...loadQuestions("holdout")];
  let failed = 0;
  for (const r of repos) {
    const problems = await validateRepo(r.repo, r.sha, all.filter((q) => q.repo === r.repo));
    console.log(`${r.repo}: ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
    for (const p of problems) console.log(`  ${p.id}: ${p.problem}`);
    failed += problems.length;
  }
  if (failed > 0) process.exitCode = 1;
}
