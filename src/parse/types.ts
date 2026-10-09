export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "variable";

export interface ExtractedSymbol {
  name: string;
  /** Dotted form for assignments like `app.listen = function`, otherwise the same as `name`. */
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  parent: string | null;
}

export type ImportKind = "esm" | "require" | "dynamic" | "reexport";

export interface ExtractedImport {
  specifier: string;
  kind: ImportKind;
  names: string[];
  line: number;
}

export interface ExtractedExport {
  name: string;
  line: number;
}

export interface ExtractedChunk {
  startLine: number;
  endLine: number;
}

/**
 * ast             — tree-sitter produced a clean tree
 * ast-with-errors — tree-sitter recovered but the tree contains ERROR/MISSING nodes
 * fallback        — AST extraction failed (exception, timeout); line windows only
 * text            — not code (markdown); line windows by design
 */
export type ParseStatus = "ast" | "ast-with-errors" | "fallback" | "text";

export interface ParsedFile {
  path: string;
  language: string;
  status: ParseStatus;
  failureReason: string | null;
  lineCount: number;
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  exports: ExtractedExport[];
  chunks: ExtractedChunk[];
  parseMs: number;
}
