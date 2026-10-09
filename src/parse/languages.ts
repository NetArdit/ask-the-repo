import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

/** The grammar or the WASM runtime could not be loaded. This is a deployment fault, not a property of one file, and must not be mistaken for a parse failure. */
export class GrammarLoadError extends Error {
  constructor(
    readonly grammar: GrammarName,
    cause: unknown,
  ) {
    super(`Cannot load the ${grammar} grammar: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GrammarLoadError";
  }
}

export type GrammarName = "javascript" | "typescript" | "tsx";

const require = createRequire(import.meta.url);
const parsers = new Map<GrammarName, Parser>();
let initialized: Promise<void> | null = null;

/** One reusable parser per grammar. Loading a grammar is the expensive part, so it happens once per process. */
export async function getParser(name: GrammarName): Promise<Parser> {
  const cached = parsers.get(name);
  if (cached) return cached;
  try {
    initialized ??= Parser.init();
    await initialized;
    // turbopackIgnore: without it Turbopack treats the template as a glob over every grammar in the package and fails the build.
    const wasm = require.resolve(/* turbopackIgnore: true */ `tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
    const language = await Language.load(wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    parsers.set(name, parser);
    return parser;
  } catch (err) {
    initialized = null;
    throw new GrammarLoadError(name, err);
  }
}

export function grammarFor(filePath: string): GrammarName | null {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    default:
      return null;
  }
}
