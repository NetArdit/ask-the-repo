import type { Readable } from "node:stream";
import { DEFAULT_LIMITS, ingestTarGz, type IngestLimits, type IngestStats } from "../ingest/tarball";
import { countLines, lineWindows } from "../parse/chunk";
import { parseSource } from "../parse/extract";
import { IndexBuilder, type EntryStats, type ImportStats } from "./build";
import { serializeIndex } from "./serialize";
import type { IndexConfig, IndexKey } from "./types";

export interface BuiltIndex {
  bytes: Buffer;
  jsonBytes: number;
  files: number;
  chunks: number;
  ingest: IngestStats;
  parseStatus: Record<string, Record<string, number>>;
  parseFallbackReasons: Record<string, number>;
  imports: ImportStats;
  entries: EntryStats;
  timings: { ingestMs: number; finishMs: number; serializeMs: number };
}

/**
 * Streams a gzipped tarball of one commit into a serialized index. Nothing is written to disk and no source text
 * survives the call; the only output is the compact artifact and statistics about how it was built.
 */
export async function buildIndexFromTarball(
  source: Readable,
  key: IndexKey,
  config: IndexConfig,
  limits: IngestLimits = DEFAULT_LIMITS,
): Promise<BuiltIndex> {
  const builder = new IndexBuilder(key, config);
  const parseStatus: Record<string, Record<string, number>> = {};
  const parseFallbackReasons: Record<string, number> = {};
  const t0 = performance.now();
  const ingest = await ingestTarGz(
    source,
    limits,
    async (file) => {
      const text = file.content.toString("utf8");
      if (file.language === "config") {
        const lineCount = countLines(text);
        builder.addFile(
          { path: file.path, language: "config", status: "text", failureReason: null, lineCount, symbols: [], imports: [], exports: [], chunks: lineWindows(lineCount), parseMs: 0 },
          text,
          file.content.length,
        );
        return;
      }
      const parsed = await parseSource(file.path, file.language, text, { variant: config.parseVariant });
      builder.addFile(parsed, text, file.content.length);
      const perLanguage = (parseStatus[file.language] ??= {});
      perLanguage[parsed.status] = (perLanguage[parsed.status] ?? 0) + 1;
      if (parsed.failureReason) parseFallbackReasons[parsed.failureReason] = (parseFallbackReasons[parsed.failureReason] ?? 0) + 1;
    },
    { includeConfig: config.includeConfig, onSkipped: (p) => builder.noteSkipped(p) },
  );
  const t1 = performance.now();
  const artifact = builder.finish();
  const t2 = performance.now();
  const serialized = serializeIndex(artifact);
  return {
    bytes: serialized.bytes,
    jsonBytes: serialized.jsonBytes,
    files: artifact.files.length,
    chunks: artifact.chunks.length,
    ingest,
    parseStatus,
    parseFallbackReasons,
    imports: builder.importStats(),
    entries: builder.entryStats(),
    timings: { ingestMs: t1 - t0, finishMs: t2 - t1, serializeMs: performance.now() - t2 },
  };
}
