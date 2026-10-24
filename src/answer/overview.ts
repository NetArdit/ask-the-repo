import { LANGUAGE_CODES } from "../index/types";
import type { LoadedIndex } from "../retrieve/loaded-index";
import type { Evidence } from "../retrieve/search";

/**
 * Questions about the whole repository ("what does this project do?", "explain the architecture") have few words that occur in
 * any one place, so retrieval by words finds nothing and the question used to be refused. For these the application offers the
 * files that introduce a project instead: the README, the manifest, the entry points. Deterministic; no model is involved.
 */
export interface OverviewEvidenceOptions {
  /** Most blocks added from the introducing files. */
  maxBlocks: number;
}

export type OverviewCandidate = Pick<Evidence, "chunkId" | "path" | "startLine" | "endLine" | "score">;

const PROJECT_NOUN = String.raw`(?:project|repo|repository|repos|app|application|codebase|code\s*base|program|software|site|website|system|library|package|tool|bot|game|api|backend|frontend|service)`;

const OVERVIEW_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\bwhat(?:'s|\s+is|\s+does|\s+do)?\b.{0,25}\b(?:this|the|that)\b.{0,12}\b${PROJECT_NOUN}\b`, "i"),
  new RegExp(String.raw`\b(?:explain|describe|summari[sz]e|overview|walk\s+me\s+through|tell\s+me\s+about|introduce)\b.{0,50}\b(?:${PROJECT_NOUN}|everything|whole|entire|architecture|structure)\b`, "i"),
  new RegExp(String.raw`\bhow\s+(?:does|do|is)\b.{0,15}\b(?:this|the|that)\b.{0,12}\b${PROJECT_NOUN}\b.{0,15}\b(?:work|built|structured|organi[sz]ed)\b`, "i"),
  /\b(?:what\s+is\s+(?:this|it)\s*\??$|what\s+is\s+it\s+for|purpose\s+of\s+(?:this|the)|main\s+(?:parts|components|features|modules)|tech(?:nology)?\s+stack|architecture|project\s+structure|folder\s+structure|directory\s+structure|how\s+is\s+it\s+(?:built|organi[sz]ed|structured))\b/i,
  // Albanian, German, Spanish, French, Italian: the same questions, since people ask in their own language.
  /\b(?:çfarë|cfare|çka|cka)\s+b[eë]n\b|\bpër\s+çfarë\s+sh[eë]rben\b|\bsi\s+funksionon\s+(?:ky|kjo|ai|ajo|projekti|aplikacioni|repo\w*|sistemi)\b|\b(?:shpjego|p[eë]rshkruaj|tregom[eë])\b.{0,40}\b(?:projekt\w*|aplikacion\w*|repo\w*|kod\w*|gjith[cç]ka|struktur\w*|project|app|codebase|architecture)|\bky\s+(?:projekt|repo|aplikacion)\b/i,
  // Mixed: an Albanian "what" with an English or Albanian project noun ("çfarë does this project do").
  /(?:^|[\s(¿"'])(?:çfarë|cfare|çka|cka)(?=\s).{0,25}\b(?:project|repo|repository|app|application|codebase|projekt\w*|aplikacion\w*|repo\w*)\b/i,
  /\bwas\s+macht\s+(?:dieses|das)\s+(?:projekt|repo|programm)\b|\bqu[eé]\s+hace\s+(?:este|el)\s+(?:proyecto|repo|programa)\b|\bque\s+fait\s+ce\s+(?:projet|d[eé]p[oô]t)\b|\bcosa\s+fa\s+(?:questo|il)\s+(?:progetto|repo)\b/i,
];

export function isOverviewQuestion(question: string): boolean {
  const q = question.trim();
  if (q.length === 0) return false;
  return OVERVIEW_PATTERNS.some((re) => re.test(q));
}

const README_RE = /^readme(\.(md|markdown|mdx|rst|txt))?$/i;
const MANIFESTS = [
  "package.json", "pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "composer.json", "Gemfile", "pubspec.yaml", "Package.swift", "mix.exs", "CMakeLists.txt", "Makefile", "Dockerfile",
];
const ENTRY_NAMES = [
  "main.py", "app.py", "__main__.py", "manage.py", "wsgi.py", "index.js", "server.js", "app.js", "main.js", "main.ts", "index.ts", "main.go", "main.rs", "lib.rs",
  "Main.java", "Application.java", "Program.cs", "index.php", "main.c", "main.cpp", "index.html", "app.tsx", "main.tsx", "index.tsx", "__init__.py",
];

function baseOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function depth(p: string): number {
  return p.split("/").length;
}

/** The file at the shallowest path among those whose base name satisfies `match`, ties broken by path so the choice is stable. */
function shallowest(index: LoadedIndex, match: (base: string) => boolean): number | null {
  let best: number | null = null;
  index.artifact.files.forEach((f, i) => {
    if (!match(baseOf(f[0]))) return;
    if (best === null) best = i;
    else {
      const a = index.artifact.files[best]![0];
      if (depth(f[0]) < depth(a) || (depth(f[0]) === depth(a) && f[0] < a)) best = i;
    }
  });
  return best;
}

/** The first chunks of the files that introduce the repository, in the order a reader would open them. */
export function overviewCandidates(index: LoadedIndex, options: OverviewEvidenceOptions): OverviewCandidate[] {
  const out: OverviewCandidate[] = [];
  const taken = new Set<number>();
  const add = (fileIdx: number | null, chunks: number): void => {
    if (fileIdx === null) return;
    const file = index.artifact.files[fileIdx]!;
    for (let c = file[5]; c < file[5] + Math.min(chunks, file[6]); c++) {
      if (out.length >= options.maxBlocks) return;
      if (taken.has(c)) continue;
      taken.add(c);
      const chunk = index.artifact.chunks[c]!;
      out.push({ chunkId: c, path: file[0], startLine: chunk[1], endLine: chunk[2], score: 0 });
    }
  };

  add(shallowest(index, (b) => README_RE.test(b)), 2);
  let manifests = 0;
  for (const name of MANIFESTS) {
    if (manifests >= 2 || out.length >= options.maxBlocks) break;
    const idx = shallowest(index, (b) => b === name);
    if (idx !== null) {
      add(idx, 1);
      manifests += 1;
    }
  }
  for (const e of index.entryFiles.slice(0, 2)) add(e.file, 1);
  let entries = 0;
  for (const name of ENTRY_NAMES) {
    if (entries >= 2 || out.length >= options.maxBlocks) break;
    const idx = shallowest(index, (b) => b === name);
    if (idx !== null) {
      add(idx, 1);
      entries += 1;
    }
  }
  return out;
}

const MAX_FOLDERS = 12;
const MAX_LANGUAGES = 6;

/**
 * The application's own one-line map of the repository: its top-level folders and the languages it is written in, read from the
 * index's file list. It is orientation for the model, like every INDEX line: not evidence, and not to be restated as a claim.
 */
export function structureNote(index: LoadedIndex): string {
  const folders = new Map<string, number>();
  const languages = new Map<string, number>();
  for (const f of index.artifact.files) {
    const parts = f[0].split("/");
    const top = parts.length === 1 ? "(root)" : parts[0]!;
    folders.set(top, (folders.get(top) ?? 0) + 1);
    const lang = LANGUAGE_CODES[f[1]] ?? "other";
    languages.set(lang, (languages.get(lang) ?? 0) + 1);
  }
  const rank = (m: Map<string, number>, n: number): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k} (${v})`);
  const more = folders.size > MAX_FOLDERS ? ` and ${folders.size - MAX_FOLDERS} more` : "";
  return `overview of ${index.fileCount} indexed files. Top-level folders by file count: ${rank(folders, MAX_FOLDERS).join(", ")}${more}. Languages: ${rank(languages, MAX_LANGUAGES).join(", ")}.`;
}
