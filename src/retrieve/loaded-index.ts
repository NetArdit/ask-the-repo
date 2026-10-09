import { identifierTerms, pathTerms, splitIdentifier, stem, type StemMode } from "../index/tokenize";
import { LANGUAGE_CODES, type IndexArtifact } from "../index/types";
import { classifyFile, type FileClass } from "./file-class";

export interface DecodedPostings {
  chunkIds: Int32Array;
  tfs: Int32Array;
}

function addTo<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Query-time view over an artifact: derived lookup tables, built once per load. */
export class LoadedIndex {
  readonly chunkCount: number;
  readonly fileCount: number;
  /** path term -> files */
  readonly filesByPathTerm = new Map<string, number[]>();
  readonly pathTermsOfFile: string[][] = [];
  /** lowercased symbol name / qualified name -> symbols */
  readonly symbolsByName = new Map<string, number[]>();
  /** symbol sub-word -> symbols */
  readonly symbolsByTerm = new Map<string, number[]>();
  readonly termsOfSymbol: string[][] = [];
  readonly exportsByName = new Map<string, number[]>();
  readonly importsOfFile = new Map<number, number[]>();
  readonly importersOfFile = new Map<number, number[]>();
  readonly stemMode: StemMode;
  readonly fileClass: FileClass[] = [];
  /** Declared package entry points that resolve to an indexed file. */
  readonly entryFiles: { file: number; kind: number; pkg: string }[] = [];
  readonly deriveMs: number;
  private readonly decoded = new Map<string, DecodedPostings | null>();

  constructor(readonly artifact: IndexArtifact) {
    const t0 = performance.now();
    this.stemMode = artifact.config.stemMode;
    this.chunkCount = artifact.chunks.length;
    this.fileCount = artifact.files.length;

    artifact.files.forEach((f, idx) => {
      this.fileClass.push(classifyFile(f[0], LANGUAGE_CODES[f[1]] === "config"));
      const terms = [...new Set(pathTerms(f[0], this.stemMode))];
      this.pathTermsOfFile.push(terms);
      for (const t of terms) addTo(this.filesByPathTerm, t, idx);
    });

    artifact.symbols.forEach((s, idx) => {
      const name = s[1];
      addTo(this.symbolsByName, name.toLowerCase(), idx);
      if (s[2]) addTo(this.symbolsByName, s[2].toLowerCase(), idx);
      const terms = [...new Set(splitIdentifier(name).map((p) => stem(p, this.stemMode)))].filter((t) => t.length >= 2);
      this.termsOfSymbol.push(terms);
      for (const t of terms) addTo(this.symbolsByTerm, t, idx);
    });

    for (const [file, kind, pkg] of artifact.entries) this.entryFiles.push({ file, kind, pkg });
    artifact.exports.forEach((e, idx) => addTo(this.exportsByName, e[1].toLowerCase(), idx));

    for (const imp of artifact.imports) {
      const [from, , , resolved] = imp;
      if (resolved < 0) continue;
      addTo(this.importsOfFile, from, resolved);
      addTo(this.importersOfFile, resolved, from);
    }
    this.deriveMs = performance.now() - t0;
  }

  pathOf(fileIdx: number): string {
    return this.artifact.files[fileIdx]![0];
  }

  /** df in chunks, or 0 when the term never occurs. */
  documentFrequency(term: string): number {
    const list = Object.hasOwn(this.artifact.postings, term) ? this.artifact.postings[term] : undefined;
    return list ? list.length / 2 : 0;
  }

  postings(term: string): DecodedPostings | null {
    if (this.decoded.has(term)) return this.decoded.get(term) ?? null;
    const raw = Object.hasOwn(this.artifact.postings, term) ? this.artifact.postings[term] : undefined;
    let result: DecodedPostings | null = null;
    if (raw) {
      const n = raw.length / 2;
      const chunkIds = new Int32Array(n);
      const tfs = new Int32Array(n);
      let id = 0;
      for (let i = 0; i < n; i++) {
        id += raw[i * 2]!;
        chunkIds[i] = id;
        tfs[i] = raw[i * 2 + 1]!;
      }
      result = { chunkIds, tfs };
    }
    this.decoded.set(term, result);
    return result;
  }

  /** The chunk of `fileIdx` that contains `line`. */
  chunkAtLine(fileIdx: number, line: number): number | null {
    const file = this.artifact.files[fileIdx]!;
    for (let c = file[5]; c < file[5] + file[6]; c++) {
      const chunk = this.artifact.chunks[c]!;
      if (line >= chunk[1] && line <= chunk[2]) return c;
    }
    return null;
  }

  chunkHash(chunkId: number): string {
    return this.artifact.chunkHashes[chunkId]!;
  }

  symbolTermsFor(name: string): string[] {
    return identifierTerms(name, this.stemMode);
  }
}
