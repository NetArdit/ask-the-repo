import type { Node } from "web-tree-sitter";
import type { Language } from "../ingest/filter";
import { MAX_CHUNK_LINES, countLines, lineWindows, mergeUnits, splitOversized, type Unit } from "./chunk";
import type { ParseVariant } from "../index/types";
import { GrammarLoadError, getParser, grammarFor, type GrammarName } from "./languages";
import type { ExtractedExport, ExtractedImport, ExtractedSymbol, ParsedFile, SymbolKind } from "./types";

const FUNCTION_TYPES = new Set(["function", "function_expression", "arrow_function", "generator_function", "generator_function_declaration"]);
const CLASS_TYPES = new Set(["class", "class_declaration", "abstract_class_declaration"]);

type ExportMode = "none" | "named" | "default";

const DEFAULT_PARSE_TIMEOUT_MS = 2_000;

function children(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

const startLine = (n: Node): number => n.startPosition.row + 1;
const endLine = (n: Node): number => n.endPosition.row + 1;

function stringValue(node: Node | null): string | null {
  if (!node || node.type !== "string") return null;
  return node.text.slice(1, -1);
}

class Extractor {
  readonly symbols: ExtractedSymbol[] = [];
  readonly imports: ExtractedImport[] = [];
  readonly exports: ExtractedExport[] = [];
  readonly units: Unit[] = [];

  run(root: Node): void {
    for (const stmt of children(root)) {
      this.addUnits(stmt);
      this.statement(stmt, "none", stmt);
    }
    this.collectCalls(root);
  }

  private addUnits(stmt: Node): void {
    const unit = { start: startLine(stmt), end: endLine(stmt) };
    if (unit.end - unit.start + 1 <= MAX_CHUNK_LINES) {
      this.units.push(unit);
      return;
    }
    const cls = this.classOf(stmt);
    const body = cls?.childForFieldName("body");
    const members = body ? children(body) : [];
    if (!cls || members.length === 0) {
      this.units.push(...splitOversized(unit));
      return;
    }
    const first = members[0]!;
    if (startLine(first) > unit.start) this.units.push({ start: unit.start, end: startLine(first) - 1 });
    for (const m of members) {
      const u = { start: startLine(m), end: endLine(m) };
      if (u.end - u.start + 1 > MAX_CHUNK_LINES) this.units.push(...splitOversized(u));
      else this.units.push(u);
    }
  }

  private classOf(stmt: Node): Node | null {
    if (CLASS_TYPES.has(stmt.type)) return stmt;
    if (stmt.type === "export_statement") {
      const inner = stmt.childForFieldName("declaration") ?? stmt.childForFieldName("value");
      if (inner && CLASS_TYPES.has(inner.type)) return inner;
    }
    return null;
  }

  private addSymbol(
    name: string,
    kind: SymbolKind,
    range: Node,
    mode: ExportMode,
    opts: { qualified?: string; parent?: string | null } = {},
  ): void {
    this.symbols.push({
      name,
      qualifiedName: opts.qualified ?? name,
      kind,
      startLine: startLine(range),
      endLine: endLine(range),
      exported: mode !== "none",
      parent: opts.parent ?? null,
    });
    if (mode === "named") this.exports.push({ name, line: startLine(range) });
  }

  private statement(node: Node, mode: ExportMode, range: Node): void {
    switch (node.type) {
      case "export_statement":
        this.exportStatement(node);
        return;
      case "import_statement":
        this.importStatement(node);
        return;
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = node.childForFieldName("name")?.text;
        if (name) this.addSymbol(name, "function", range, mode);
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) this.addSymbol(name, "class", range, mode);
        this.classMembers(node, name ?? null, mode !== "none");
        return;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text;
        const kind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "type";
        if (name) this.addSymbol(name, kind, range, mode);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const decl of children(node)) {
          if (decl.type !== "variable_declarator") continue;
          const nameNode = decl.childForFieldName("name");
          if (nameNode?.type !== "identifier") continue;
          const value = decl.childForFieldName("value");
          const kind: SymbolKind = value && FUNCTION_TYPES.has(value.type) ? "function" : "variable";
          this.addSymbol(nameNode.text, kind, range, mode);
        }
        return;
      case "expression_statement":
        this.expressionStatement(node);
        return;
      default:
        return;
    }
  }

  private classMembers(cls: Node, className: string | null, exported: boolean): void {
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (const member of children(body)) {
      const isMethod = member.type === "method_definition" || member.type === "abstract_method_signature";
      const isFieldFn =
        member.type === "public_field_definition" || member.type === "field_definition"
          ? FUNCTION_TYPES.has(member.childForFieldName("value")?.type ?? "")
          : false;
      if (!isMethod && !isFieldFn) continue;
      const name = (member.childForFieldName("name") ?? member.childForFieldName("property"))?.text;
      if (!name) continue;
      this.symbols.push({
        name,
        qualifiedName: className ? `${className}.${name}` : name,
        kind: "method",
        startLine: startLine(member),
        endLine: endLine(member),
        exported,
        parent: className,
      });
    }
  }

  private exportStatement(node: Node): void {
    const decl = node.childForFieldName("declaration");
    const value = node.childForFieldName("value");
    const source = stringValue(node.childForFieldName("source"));
    const isDefault = node.children.some((c) => c?.type === "default");
    const names: string[] = [];

    for (const child of children(node)) {
      if (child.type === "export_clause") {
        for (const spec of children(child)) {
          const exported = (spec.childForFieldName("alias") ?? spec.childForFieldName("name"))?.text;
          const original = spec.childForFieldName("name")?.text;
          if (exported) this.exports.push({ name: exported, line: startLine(node) });
          if (original) names.push(original);
        }
      } else if (child.type === "namespace_export") {
        const ns = children(child)[0]?.text;
        this.exports.push({ name: ns ?? "*", line: startLine(node) });
        names.push("*");
      }
    }
    if (node.children.some((c) => c?.type === "*")) {
      this.exports.push({ name: "*", line: startLine(node) });
      names.push("*");
    }
    if (source !== null) {
      this.imports.push({ specifier: source, kind: "reexport", names, line: startLine(node) });
    }

    if (decl) {
      if (isDefault) this.exports.push({ name: "default", line: startLine(node) });
      this.statement(decl, isDefault ? "default" : "named", node);
    } else if (isDefault) {
      this.exports.push({ name: "default", line: startLine(node) });
      if (value && (FUNCTION_TYPES.has(value.type) || CLASS_TYPES.has(value.type))) {
        const name = value.childForFieldName("name")?.text;
        if (name) {
          const kind: SymbolKind = CLASS_TYPES.has(value.type) ? "class" : "function";
          this.addSymbol(name, kind, node, "default");
          if (kind === "class") this.classMembers(value, name, true);
        }
      }
    }
  }

  private importStatement(node: Node): void {
    const specifier = stringValue(node.childForFieldName("source"));
    if (specifier === null) return;
    const names: string[] = [];
    for (const child of children(node)) {
      if (child.type !== "import_clause") continue;
      for (const part of children(child)) {
        if (part.type === "identifier") names.push("default");
        else if (part.type === "namespace_import") names.push("*");
        else if (part.type === "named_imports") {
          for (const spec of children(part)) {
            const n = spec.childForFieldName("name")?.text;
            if (n) names.push(n);
          }
        }
      }
    }
    this.imports.push({ specifier, kind: "esm", names, line: startLine(node) });
  }

  /** CommonJS patterns: `module.exports = ...`, `exports.x = ...`, and `obj.method = function () {}`. */
  private expressionStatement(node: Node): void {
    const expr = children(node)[0];
    if (!expr || expr.type !== "assignment_expression") return;
    const left = expr.childForFieldName("left");
    const right = expr.childForFieldName("right");
    if (!left || !right || left.type !== "member_expression") return;
    const leftText = left.text;
    const isFn = FUNCTION_TYPES.has(right.type) || CLASS_TYPES.has(right.type);
    const fnName = right.childForFieldName("name")?.text;

    if (leftText === "module.exports") {
      this.exports.push({ name: "default", line: startLine(node) });
      if (right.type === "object") {
        for (const prop of children(right)) {
          const key = prop.type === "shorthand_property_identifier" ? prop.text : prop.childForFieldName("key")?.text;
          if (key) this.exports.push({ name: key, line: startLine(prop) });
        }
      } else if (isFn && fnName) {
        this.addSymbol(fnName, CLASS_TYPES.has(right.type) ? "class" : "function", node, "default");
      }
      return;
    }
    const exportsMatch = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(leftText);
    if (exportsMatch) {
      const name = exportsMatch[1]!;
      this.exports.push({ name, line: startLine(node) });
      if (isFn) this.addSymbol(name, "function", node, "none", { qualified: leftText });
      return;
    }
    if (isFn) {
      const prop = left.childForFieldName("property")?.text;
      if (prop) this.addSymbol(prop, CLASS_TYPES.has(right.type) ? "class" : "function", node, "none", { qualified: leftText });
    }
  }

  /** `require("x")` and `import("x")` can appear anywhere, so they are collected tree-wide. */
  private collectCalls(root: Node): void {
    for (const call of root.descendantsOfType("call_expression")) {
      if (!call) continue;
      const fn = call.childForFieldName("function");
      const args = call.childForFieldName("arguments");
      if (!fn || !args) continue;
      const isRequire = fn.type === "identifier" && fn.text === "require";
      const isDynamic = fn.type === "import";
      if (!isRequire && !isDynamic) continue;
      const specifier = stringValue(children(args)[0] ?? null);
      if (specifier === null) continue;
      this.imports.push({
        specifier,
        kind: isRequire ? "require" : "dynamic",
        names: isRequire ? requireNames(call) : [],
        line: startLine(call),
      });
    }
  }
}

function requireNames(call: Node): string[] {
  const parent = call.parent;
  if (!parent || parent.type !== "variable_declarator") return [];
  if (parent.childForFieldName("value")?.id !== call.id) return [];
  const target = parent.childForFieldName("name");
  if (!target) return [];
  if (target.type === "identifier") return [target.text];
  if (target.type === "object_pattern") {
    const out: string[] = [];
    for (const p of children(target)) {
      if (p.type === "shorthand_property_identifier_pattern") out.push(p.text);
      else if (p.type === "pair_pattern") {
        const key = p.childForFieldName("key")?.text;
        if (key) out.push(key);
      }
    }
    return out;
  }
  return [];
}

function emptyResult(path: string, language: string, lineCount: number): ParsedFile {
  return {
    path,
    language,
    status: "fallback",
    failureReason: null,
    lineCount,
    symbols: [],
    imports: [],
    exports: [],
    chunks: [],
    parseMs: 0,
  };
}

function errorNodeCount(root: Node): number {
  return root.descendantsOfType("ERROR").length;
}

export async function parseSource(
  path: string,
  language: Language,
  text: string,
  opts: { timeoutMs?: number; variant?: ParseVariant } = {},
): Promise<ParsedFile> {
  const lineCount = countLines(text);
  const base = emptyResult(path, language, lineCount);
  if (language === "markdown" || language === "other") {
    return { ...base, status: "text", chunks: lineWindows(lineCount) };
  }
  const fallback = (reason: string, parseMs: number): ParsedFile => ({
    ...base,
    status: "fallback",
    failureReason: reason,
    chunks: lineWindows(lineCount),
    parseMs,
  });

  const grammar = grammarFor(path);
  if (!grammar) return fallback("no-grammar", 0);

  const started = performance.now();
  const deadline = started + (opts.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS);
  try {
    const parseWith = async (g: GrammarName) =>
      (await getParser(g)).parse(text, null, { progressCallback: () => performance.now() > deadline } as never);
    let tree = await parseWith(grammar);
    // Flow-typed JavaScript is mostly TypeScript-compatible syntax: retry with the TSX grammar and keep the cleaner tree.
    if (tree && opts.variant === "flow-tsx-fallback" && grammar === "javascript" && tree.rootNode.hasError) {
      const alt = await parseWith("tsx");
      if (alt && errorNodeCount(alt.rootNode) < errorNodeCount(tree.rootNode)) {
        tree.delete();
        tree = alt;
      } else alt?.delete();
    }
    const parseMs = performance.now() - started;
    if (!tree) return fallback("parse-timeout", parseMs);
    try {
      const extractor = new Extractor();
      extractor.run(tree.rootNode);
      return {
        ...base,
        status: tree.rootNode.hasError ? "ast-with-errors" : "ast",
        symbols: extractor.symbols,
        imports: extractor.imports,
        exports: extractor.exports,
        chunks: mergeUnits(extractor.units, lineCount),
        parseMs: performance.now() - started,
      };
    } finally {
      tree.delete();
    }
  } catch (err) {
    // A missing grammar would otherwise turn every file into a line-window fallback and still report success.
    if (err instanceof GrammarLoadError) throw err;
    return fallback(`exception: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), performance.now() - started);
  }
}
