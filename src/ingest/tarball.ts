import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { classifyContent, classifyPath, languageOf, type Language, type SkipReason } from "./filter";
import { normalizeArchivePath, stripArchiveRoot, type PathRejection } from "./paths";

export interface IngestLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxTotalMs: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxCompressedBytes: 150 * 1024 * 1024,
  maxUncompressedBytes: 600 * 1024 * 1024,
  maxEntries: 150_000,
  maxFileBytes: 1024 * 1024,
  maxTotalMs: 120_000,
};

export type LimitKind = "compressed-bytes" | "uncompressed-bytes" | "entries" | "total-time";

export class LimitExceededError extends Error {
  constructor(
    readonly kind: LimitKind,
    readonly limit: number,
  ) {
    super(`Ingestion limit exceeded: ${kind} > ${limit}`);
    this.name = "LimitExceededError";
  }
}

export interface IngestedFile {
  path: string;
  content: Buffer;
  language: Language;
}

export interface IngestStats {
  compressedBytes: number;
  uncompressedBytes: number;
  entries: number;
  nonFileEntries: number;
  skipped: Partial<Record<SkipReason, number>>;
  rejectedPaths: Partial<Record<PathRejection | "no-root", number>>;
  delivered: number;
  deliveredBytes: number;
}

function byteCounter(onBytes: (total: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      try {
        onBytes(total);
        cb(null, chunk);
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Streams a gzipped tar of a GitHub repository, enforcing hard limits while data flows.
 * File contents are handed to `onFile` and never written to disk; archive paths are
 * identifiers only, so tar-slip has nothing to exploit.
 */
export interface IngestOptions {
  includeConfig?: boolean;
  /** Called for every file skipped by path or content rules, so callers can tell "excluded" from "missing". */
  onSkipped?: (path: string, reason: SkipReason) => void;
}

export async function ingestTarGz(
  source: Readable,
  limits: IngestLimits,
  onFile: (file: IngestedFile) => void | Promise<void>,
  options: IngestOptions = {},
): Promise<IngestStats> {
  const stats: IngestStats = {
    compressedBytes: 0,
    uncompressedBytes: 0,
    entries: 0,
    nonFileEntries: 0,
    skipped: {},
    rejectedPaths: {},
    delivered: 0,
    deliveredBytes: 0,
  };
  const abort = new AbortController();
  let failure: Error | null = null;
  const fail = (err: Error): void => {
    failure ??= err;
    abort.abort(err);
  };
  const skip = (reason: SkipReason, skippedPath: string): void => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    options.onSkipped?.(skippedPath, reason);
  };

  const timer = setTimeout(() => fail(new LimitExceededError("total-time", limits.maxTotalMs)), limits.maxTotalMs);
  const extract = tar.extract();

  const compressed = byteCounter((n) => {
    stats.compressedBytes = n;
    if (n > limits.maxCompressedBytes) throw new LimitExceededError("compressed-bytes", limits.maxCompressedBytes);
  });
  const uncompressed = byteCounter((n) => {
    stats.uncompressedBytes = n;
    if (n > limits.maxUncompressedBytes) throw new LimitExceededError("uncompressed-bytes", limits.maxUncompressedBytes);
  });

  const piping = pipeline(source, compressed, createGunzip(), uncompressed, extract, { signal: abort.signal });
  piping.catch((err: Error) => fail(err));

  try {
    for await (const entry of extract) {
      stats.entries += 1;
      if (stats.entries > limits.maxEntries) {
        fail(new LimitExceededError("entries", limits.maxEntries));
        break;
      }
      const { name, type, size } = entry.header;
      if (type !== "file") {
        stats.nonFileEntries += 1;
        entry.resume();
        continue;
      }
      const relative = stripArchiveRoot(name);
      const normalized = relative === null ? null : normalizeArchivePath(relative);
      if (normalized === null || !normalized.ok) {
        const reason = normalized === null ? "no-root" : normalized.reason;
        stats.rejectedPaths[reason] = (stats.rejectedPaths[reason] ?? 0) + 1;
        entry.resume();
        continue;
      }
      const pathSkip = classifyPath(normalized.path, options);
      if (pathSkip) {
        skip(pathSkip, normalized.path);
        entry.resume();
        continue;
      }
      if ((size ?? 0) > limits.maxFileBytes) {
        skip("too-large", normalized.path);
        entry.resume();
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      const content = Buffer.concat(chunks);
      const language = languageOf(normalized.path);
      const contentSkip = classifyContent(content, language);
      if (contentSkip) {
        skip(contentSkip, normalized.path);
        continue;
      }
      stats.delivered += 1;
      stats.deliveredBytes += content.length;
      await onFile({ path: normalized.path, content, language });
    }
    await piping;
  } catch (err) {
    failure ??= err as Error;
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
  if (failure) {
    const error = failure.name === "AbortError" && abort.signal.reason instanceof Error ? abort.signal.reason : failure;
    throw Object.assign(error, { ingestStats: stats });
  }
  return stats;
}
