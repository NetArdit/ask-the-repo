import type { StemMode } from "./tokenize";

export const INDEX_VERSION = 3;

export interface IndexKey {
  owner: string;
  repo: string;
  sha: string;
}

export const LANGUAGE_CODES = ["javascript", "typescript", "tsx", "markdown", "config"] as const;
export const STATUS_CODES = ["ast", "ast-with-errors", "fallback", "text"] as const;
export const SYMBOL_KIND_CODES = ["function", "class", "method", "interface", "type", "enum", "variable"] as const;
export const IMPORT_KIND_CODES = ["esm", "require", "dynamic", "reexport"] as const;
export const ENTRY_KIND_CODES = ["main", "module", "bin", "exports", "browser", "types"] as const;

/** Resolution codes for imports whose target file is not known. */
export const UNRESOLVED_RELATIVE = -1;
export const EXTERNAL_PACKAGE = -2;
export const ALIAS_SPECIFIER = -3;

export type ParseVariant = "default" | "flow-tsx-fallback";

/** Everything about how an index was built that a query must know or an experiment must vary. */
export interface IndexConfig {
  stemMode: StemMode;
  /** Index package.json / tsconfig.json and similar configuration files and derive entry-point metadata from them. */
  includeConfig: boolean;
  parseVariant: ParseVariant;
  /** Resolve bare specifiers that name a workspace package, and tsconfig `paths` / `baseUrl` aliases. Needs includeConfig. */
  resolveWorkspaceAndAliases: boolean;
}

export const BASELINE_CONFIG: IndexConfig = {
  stemMode: "plural",
  includeConfig: false,
  parseVariant: "default",
  resolveWorkspaceAndAliases: false,
};

/**
 * Compact on-disk form. It holds metadata and derived search terms only: no source text.
 * Row layouts are documented next to each field; postings are delta-coded [chunkDelta, tf, ...].
 */
export interface IndexArtifact {
  version: typeof INDEX_VERSION;
  key: IndexKey;
  createdAt: string;
  config: IndexConfig;
  /** [path, languageCode, statusCode, lineCount, sizeBytes, firstChunk, chunkCount] */
  files: [string, number, number, number, number, number, number][];
  /** [fileIdx, name, qualifiedName | "", kindCode, startLine, endLine, exported(0|1), parent | ""] */
  symbols: [number, string, string, number, number, number, number, string][];
  /** [fileIdx, specifier, kindCode, resolvedFileIdx | negative code, line, names] */
  imports: [number, string, number, number, number, string[]][];
  /** [fileIdx, name, line] */
  exports: [number, string, number][];
  /** Declared package entry points that resolve to an indexed file: [fileIdx, entryKindCode, packageName] */
  entries: [number, number, string][];
  /** [fileIdx, startLine, endLine, termCount] */
  chunks: [number, number, number, number][];
  /** One per chunk, in chunk order: fingerprint of the chunk's source lines at the indexed commit. No source text. */
  chunkHashes: string[];
  postings: Record<string, number[]>;
  avgChunkLength: number;
}
