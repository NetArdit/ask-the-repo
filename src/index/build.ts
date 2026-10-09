import { builtinModules } from "node:module";
import path from "node:path/posix";
import type { ParsedFile } from "../parse/types";
import { hashLines } from "./hash";
import { termFrequencies } from "./tokenize";
import {
  ALIAS_SPECIFIER,
  BASELINE_CONFIG,
  ENTRY_KIND_CODES,
  EXTERNAL_PACKAGE,
  IMPORT_KIND_CODES,
  INDEX_VERSION,
  LANGUAGE_CODES,
  STATUS_CODES,
  SYMBOL_KIND_CODES,
  UNRESOLVED_RELATIVE,
  type IndexArtifact,
  type IndexConfig,
  type IndexKey,
} from "./types";

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const BUILD_DIRS = ["dist", "build", "out", "distribution", "esm", "cjs", "lib"];
const SOURCE_DIRS = ["src", "source", "lib"];
const ASSET_RE = /\.(css|scss|sass|less|svg|png|jpe?g|gif|json|md|html|txt|wasm|node|woff2?)$/i;
const BUILTINS = new Set(builtinModules);

export function resolveImport(fromFile: string, specifier: string, fileSet: ReadonlySet<string>, options: { declarations?: boolean } = {}): string | null {
  const base = path.join(path.dirname(fromFile), specifier);
  const candidates = [base];
  if (options.declarations) candidates.push(`${base}.d.ts`, path.join(base, "index.d.ts"));
  const ext = path.extname(base);
  for (const e of RESOLVE_EXTENSIONS) candidates.push(base + e);
  for (const e of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${e}`));
  for (const alt of JS_TO_TS[ext] ?? []) candidates.push(base.slice(0, -ext.length) + alt);
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

/** Removes comments and trailing commas so tsconfig-style JSONC can go through JSON.parse. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

interface PendingImport {
  fileIdx: number;
  specifier: string;
  kind: number;
  line: number;
  names: string[];
}

interface PackageRecord {
  dir: string;
  name: string;
  targets: { kind: number; target: string }[];
}

interface TsconfigRecord {
  dir: string;
  baseDir: string;
  hasBaseUrl: boolean;
  paths: [string, string[]][];
}

export interface ImportStats {
  total: number;
  categories: Record<string, number>;
  /** Share of relative imports that resolved to an indexed file, and the same for all imports that could in principle resolve. */
  relativeResolved: number;
  relativeTotal: number;
  /** A few "importing file -> specifier" examples per unresolved category, for failure analysis. */
  samples: Record<string, string[]>;
}

export interface EntryStats {
  declared: number;
  resolved: number;
  unresolved: string[];
}

function collectExportTargets(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectExportTargets(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectExportTargets(v, out);
}

function packageTargets(json: Record<string, unknown>): { kind: number; target: string }[] {
  const out: { kind: number; target: string }[] = [];
  const add = (kind: (typeof ENTRY_KIND_CODES)[number], value: unknown): void => {
    const targets: string[] = [];
    collectExportTargets(value, targets);
    for (const raw of targets) {
      if (/.d.[cm]?ts$/.test(raw) || /.(css|json|map)$/.test(raw) || raw.startsWith("/")) continue;
      out.push({ kind: ENTRY_KIND_CODES.indexOf(kind), target: raw.startsWith(".") ? raw : `./${raw}` });
    }
  };
  add("main", json.main);
  add("module", json.module);
  add("browser", typeof json.browser === "string" ? json.browser : undefined);
  const bin = json.bin;
  add("bin", typeof bin === "string" ? bin : bin && typeof bin === "object" ? Object.values(bin) : undefined);
  add("exports", json.exports);
  // Node resolves a package without main/exports/bin to ./index.js
  if (out.length === 0) out.push({ kind: ENTRY_KIND_CODES.indexOf("main"), target: "./index.js" });
  return out;
}

/** Accumulates parsed files one at a time so source text never has to be retained. */
export class IndexBuilder {
  private readonly files: IndexArtifact["files"] = [];
  private readonly symbols: IndexArtifact["symbols"] = [];
  private readonly exports: IndexArtifact["exports"] = [];
  private readonly chunks: IndexArtifact["chunks"] = [];
  private readonly chunkHashes: string[] = [];
  private readonly postings = new Map<string, number[]>();
  private readonly pendingImports: PendingImport[] = [];
  private readonly packages: PackageRecord[] = [];
  private readonly tsconfigs: TsconfigRecord[] = [];
  private readonly skippedPaths = new Set<string>();
  private totalChunkLength = 0;
  private lastImportStats: ImportStats | null = null;
  private lastEntryStats: EntryStats | null = null;

  constructor(
    private readonly key: IndexKey,
    private readonly config: IndexConfig = BASELINE_CONFIG,
  ) {}

  /** Remembers files that ingestion deliberately dropped, so unresolved imports can be classified as "excluded" rather than "missing". */
  noteSkipped(filePath: string): void {
    this.skippedPaths.add(filePath);
  }

  private addChunks(fileIdx: number, parsed: ParsedFile, text: string): void {
    const lines = text.split("\n");
    for (const chunk of parsed.chunks) {
      const chunkId = this.chunks.length;
      const chunkLines = lines.slice(chunk.startLine - 1, chunk.endLine);
      this.chunkHashes.push(hashLines(chunkLines));
      const tf = termFrequencies(chunkLines.join("\n"), this.config.stemMode);
      let length = 0;
      for (const [term, count] of tf) {
        length += count;
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = []));
        list.push(chunkId, count);
      }
      this.chunks.push([fileIdx, chunk.startLine, chunk.endLine, length]);
      this.totalChunkLength += length;
    }
  }

  addFile(parsed: ParsedFile, text: string, sizeBytes: number): void {
    const fileIdx = this.files.length;
    const firstChunk = this.chunks.length;
    this.addChunks(fileIdx, parsed, text);
    this.files.push([
      parsed.path,
      Math.max(0, LANGUAGE_CODES.indexOf(parsed.language as (typeof LANGUAGE_CODES)[number])),
      STATUS_CODES.indexOf(parsed.status),
      parsed.lineCount,
      sizeBytes,
      firstChunk,
      parsed.chunks.length,
    ]);
    for (const s of parsed.symbols) {
      this.symbols.push([
        fileIdx,
        s.name,
        s.qualifiedName === s.name ? "" : s.qualifiedName,
        SYMBOL_KIND_CODES.indexOf(s.kind),
        s.startLine,
        s.endLine,
        s.exported ? 1 : 0,
        s.parent ?? "",
      ]);
    }
    for (const e of parsed.exports) this.exports.push([fileIdx, e.name, e.line]);
    for (const i of parsed.imports) {
      this.pendingImports.push({ fileIdx, specifier: i.specifier, kind: IMPORT_KIND_CODES.indexOf(i.kind), line: i.line, names: i.names });
    }
    if (parsed.language === "config") this.readConfig(parsed.path, text);
  }

  private readConfig(filePath: string, text: string): void {
    let json: unknown;
    try {
      json = parseJsonc(text);
    } catch {
      return;
    }
    if (!json || typeof json !== "object") return;
    const record = json as Record<string, unknown>;
    const dir = path.dirname(filePath) === "." ? "" : path.dirname(filePath);
    const base = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (base === "package.json") {
      this.packages.push({ dir, name: typeof record.name === "string" ? record.name : "", targets: packageTargets(record) });
    } else if (base.startsWith("tsconfig") || base === "jsconfig.json") {
      const opts = (record.compilerOptions ?? {}) as { baseUrl?: unknown; paths?: Record<string, string[]> };
      const baseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl : null;
      if (!baseUrl && !opts.paths) return;
      this.tsconfigs.push({
        dir,
        baseDir: path.normalize(path.join(dir, baseUrl ?? ".")).replace(/^\.$/, ""),
        hasBaseUrl: baseUrl !== null,
        paths: Object.entries(opts.paths ?? {}).filter((e): e is [string, string[]] => Array.isArray(e[1])),
      });
    }
  }

  private resolveDeclaredTarget(dir: string, target: string, fileSet: ReadonlySet<string>): string | null {
    const from = path.join(dir, "package.json");
    const direct = resolveImport(from, target, fileSet);
    if (direct) return direct;
    // Built output is rarely in the repository: map dist/lib-style folders back to source folders.
    const rel = path.normalize(target).replace(/^\.\//, "");
    const segments = rel.split("/");
    const first = segments[0] ?? "";
    if (BUILD_DIRS.includes(first)) {
      for (const srcDir of SOURCE_DIRS) {
        const hit = resolveImport(from, `./${[srcDir, ...segments.slice(1)].join("/")}`, fileSet);
        if (hit) return hit;
      }
    }
    for (const srcDir of SOURCE_DIRS) {
      const hit = resolveImport(from, `./${srcDir}/${segments[segments.length - 1] ?? ""}`, fileSet);
      if (hit) return hit;
    }
    return null;
  }

  private aliasCandidates(fromFile: string, specifier: string): { baseDir: string; target: string }[] {
    const out: { baseDir: string; target: string }[] = [];
    const dir = path.dirname(fromFile);
    const rules = this.tsconfigs
      .filter((t) => t.dir === "" || dir === t.dir || dir.startsWith(`${t.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length);
    for (const t of rules) {
      for (const [pattern, targets] of t.paths) {
        const star = pattern.indexOf("*");
        let captured: string | null = null;
        if (star === -1) captured = pattern === specifier ? "" : null;
        else {
          const prefix = pattern.slice(0, star);
          const suffix = pattern.slice(star + 1);
          if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
            captured = specifier.slice(prefix.length, specifier.length - suffix.length);
          }
        }
        if (captured === null) continue;
        for (const target of targets) out.push({ baseDir: t.baseDir, target: target.replace("*", captured) });
      }
      if (t.hasBaseUrl) out.push({ baseDir: t.baseDir, target: specifier });
    }
    return out;
  }

  finish(): IndexArtifact {
    const fileIndex = new Map(this.files.map((f, i) => [f[0], i] as const));
    const fileSet: ReadonlySet<string> = new Set(fileIndex.keys());
    const categories: Record<string, number> = {};
    const samples: Record<string, string[]> = {};
    const count = (category: string, example?: string): void => {
      categories[category] = (categories[category] ?? 0) + 1;
      if (example && category.includes("unresolved")) {
        const list = (samples[category] ??= []);
        if (list.length < 8) list.push(example);
      }
    };

    // Declared entry points, resolved to indexed files.
    const entries: IndexArtifact["entries"] = [];
    const entryStats: EntryStats = { declared: 0, resolved: 0, unresolved: [] };
    const packageEntryFile = new Map<string, string>();
    const entryByDir = new Map<string, string>();
    for (const pkg of this.packages) {
      for (const t of pkg.targets) {
        entryStats.declared += 1;
        const hit = this.resolveDeclaredTarget(pkg.dir, t.target, fileSet);
        if (!hit) {
          entryStats.unresolved.push(`${pkg.dir || "."}:${t.target}`);
          continue;
        }
        entryStats.resolved += 1;
        entries.push([fileIndex.get(hit)!, t.kind, pkg.name || pkg.dir]);
        if (pkg.name && !packageEntryFile.has(pkg.name)) packageEntryFile.set(pkg.name, hit);
        if (!entryByDir.has(pkg.dir)) entryByDir.set(pkg.dir, hit);
      }
    }
    const packageByName = new Map(this.packages.filter((p) => p.name).map((p) => [p.name, p] as const));
    const resolveExtras = this.config.includeConfig && this.config.resolveWorkspaceAndAliases;

    const imports: IndexArtifact["imports"] = this.pendingImports.map((p) => {
      const from = this.files[p.fileIdx]![0];
      let resolved = EXTERNAL_PACKAGE;
      if (p.specifier.startsWith(".")) {
        let target = resolveImport(from, p.specifier, fileSet, { declarations: resolveExtras });
        // A directory import resolves to the package entry declared by that directory's package.json.
        if (target === null && resolveExtras) target = entryByDir.get(path.normalize(path.join(path.dirname(from), p.specifier)).replace(/^.$/, "")) ?? null;
        if (target !== null) {
          resolved = fileIndex.get(target)!;
          count("relative:resolved");
        } else {
          resolved = UNRESOLVED_RELATIVE;
          if (ASSET_RE.test(p.specifier)) count("relative:unresolved-asset");
          else {
            const base = path.join(path.dirname(from), p.specifier);
            const excluded = [base, ...RESOLVE_EXTENSIONS.map((e) => base + e), ...RESOLVE_EXTENSIONS.map((e) => path.join(base, `index${e}`))].some((c) => this.skippedPaths.has(c));
            count(excluded ? "relative:unresolved-excluded-file" : "relative:unresolved-missing", `${from} -> ${p.specifier}`);
          }
        }
      } else if (p.specifier.startsWith("node:") || BUILTINS.has(p.specifier)) {
        count("bare:node-builtin");
      } else {
        const pkgName = packageNameOf(p.specifier);
        const pkg = packageByName.get(pkgName);
        const isAliasShape = p.specifier.startsWith("@/") || p.specifier.startsWith("~/") || p.specifier.startsWith("#");
        let hit: string | null = null;
        let category: string;
        if (resolveExtras) {
          for (const c of this.aliasCandidates(from, p.specifier)) {
            hit = resolveImport(path.join(c.baseDir, "_"), `./${c.target}`, fileSet);
            if (hit) break;
          }
          if (hit) category = "alias-or-baseurl:resolved";
          else if (pkg) {
            const sub = p.specifier.slice(pkgName.length + 1);
            hit = sub
              ? (resolveImport(path.join(pkg.dir, "x.js"), `./${sub}`, fileSet) ?? resolveImport(path.join(pkg.dir, "src", "x.js"), `./${sub}`, fileSet))
              : (packageEntryFile.get(pkgName) ?? null);
            category = hit ? "workspace-package:resolved" : "workspace-package:unresolved";
          } else category = isAliasShape ? "alias:unresolved" : "bare:external-package";
        } else if (isAliasShape) category = "alias:unresolved";
        else category = pkg ? "bare:workspace-package-not-resolved" : "bare:external-package";
        count(category, `${from} -> ${p.specifier}`);
        if (hit) resolved = fileIndex.get(hit)!;
        else if (isAliasShape) resolved = ALIAS_SPECIFIER;
      }
      return [p.fileIdx, p.specifier, p.kind, resolved, p.line, p.names];
    });

    const relativeTotal = (categories["relative:resolved"] ?? 0) + Object.entries(categories).filter(([k]) => k.startsWith("relative:unresolved")).reduce((a, [, v]) => a + v, 0);
    this.lastImportStats = { total: imports.length, categories, relativeResolved: categories["relative:resolved"] ?? 0, relativeTotal, samples };
    this.lastEntryStats = entryStats;

    const postings: Record<string, number[]> = {};
    for (const [term, list] of this.postings) {
      const delta: number[] = new Array<number>(list.length);
      let prev = 0;
      for (let i = 0; i < list.length; i += 2) {
        delta[i] = list[i]! - prev;
        delta[i + 1] = list[i + 1]!;
        prev = list[i]!;
      }
      postings[term] = delta;
    }

    return {
      version: INDEX_VERSION,
      key: this.key,
      createdAt: new Date().toISOString(),
      config: this.config,
      files: this.files,
      symbols: this.symbols,
      imports,
      exports: this.exports,
      entries,
      chunks: this.chunks,
      chunkHashes: this.chunkHashes,
      postings,
      avgChunkLength: this.chunks.length === 0 ? 0 : this.totalChunkLength / this.chunks.length,
    };
  }

  importStats(): ImportStats {
    if (!this.lastImportStats) throw new Error("importStats() requires finish() first");
    return this.lastImportStats;
  }

  entryStats(): EntryStats {
    if (!this.lastEntryStats) throw new Error("entryStats() requires finish() first");
    return this.lastEntryStats;
  }
}

