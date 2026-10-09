import { hashLines, splitLines } from "../index/hash";
import type { LoadedIndex } from "../retrieve/loaded-index";
import type { Evidence } from "../retrieve/search";
import type { EvidenceItem, RepoIdentity } from "./types";
import type { SourceProvider } from "./source";

export function stableEvidenceKey(repo: RepoIdentity, path: string, startLine: number, endLine: number): string {
  return `${repo.owner}/${repo.repo}@${repo.sha}:${path}#L${startLine}-L${endLine}`;
}

/** Permalink pinned to the commit, built here so a model can never supply a URL. */
export function permalink(item: Pick<EvidenceItem, "repo" | "path" | "startLine" | "endLine">): string {
  const path = item.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${item.repo.owner}/${item.repo.repo}/blob/${item.repo.sha}/${path}#L${item.startLine}-L${item.endLine}`;
}

const INSTRUCTION_LIKE =
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)|disregard (the )?(system|previous)|reveal (the |your )?(system )?prompt|system override|you are now|as an? (ai|assistant)[, ]/i;

const PREFETCH_CONCURRENCY = 4;

export interface RejectedCandidate {
  path: string;
  startLine: number;
  endLine: number;
  reason: "source-unavailable" | "source-mismatch" | "range-outside-file";
}

export interface AssembledEvidence {
  items: EvidenceItem[];
  rejected: RejectedCandidate[];
  omittedForBudget: number;
  totalChars: number;
}

/**
 * Turns ranked chunks into verified evidence: the source is fetched at the pinned commit and each span's fingerprint
 * must equal the fingerprint recorded when the index was built. A span that fails never reaches the model.
 */
export async function assembleEvidence(opts: {
  index: LoadedIndex;
  repo: RepoIdentity;
  candidates: Pick<Evidence, "chunkId" | "path" | "startLine" | "endLine" | "score">[];
  source: SourceProvider;
  maxItems: number;
  budgetChars: number;
}): Promise<AssembledEvidence> {
  const files = new Map<string, string[] | null>();
  // Fetch the files the first candidates need together, a few at a time; ranking order is unchanged.
  const wanted = [...new Set(opts.candidates.slice(0, opts.maxItems + 2).map((c) => c.path))];
  for (let i = 0; i < wanted.length; i += PREFETCH_CONCURRENCY) {
    await Promise.all(
      wanted.slice(i, i + PREFETCH_CONCURRENCY).map(async (p) => {
        const text = await opts.source.getFile(opts.repo, p);
        files.set(p, text === null ? null : splitLines(text));
      }),
    );
  }
  const result: AssembledEvidence = { items: [], rejected: [], omittedForBudget: 0, totalChars: 0 };
  for (const c of opts.candidates) {
    if (result.items.length >= opts.maxItems) {
      result.omittedForBudget += 1;
      continue;
    }
    if (!files.has(c.path)) {
      const text = await opts.source.getFile(opts.repo, c.path);
      files.set(c.path, text === null ? null : splitLines(text));
    }
    const lines = files.get(c.path);
    const base = { path: c.path, startLine: c.startLine, endLine: c.endLine };
    if (!lines) {
      result.rejected.push({ ...base, reason: "source-unavailable" });
      continue;
    }
    if (c.startLine < 1 || c.endLine > lines.length || c.startLine > c.endLine) {
      result.rejected.push({ ...base, reason: "range-outside-file" });
      continue;
    }
    const span = lines.slice(c.startLine - 1, c.endLine);
    if (hashLines(span) !== opts.index.chunkHash(c.chunkId)) {
      result.rejected.push({ ...base, reason: "source-mismatch" });
      continue;
    }
    const text = span.join("\n");
    if (result.totalChars + text.length > opts.budgetChars && result.items.length > 0) {
      result.omittedForBudget += 1;
      continue;
    }
    const item: EvidenceItem = {
      id: `E${result.items.length + 1}`,
      key: stableEvidenceKey(opts.repo, c.path, c.startLine, c.endLine),
      repo: opts.repo,
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      text,
      chunkHash: opts.index.chunkHash(c.chunkId),
      fileLineCount: lines.length,
      score: c.score,
      injectionSuspect: INSTRUCTION_LIKE.test(text),
    };
    result.items.push(item);
    result.totalChars += text.length;
  }
  return result;
}
