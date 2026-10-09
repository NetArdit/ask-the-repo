import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { INDEX_VERSION, type IndexArtifact } from "./types";

export interface SerializedIndex {
  bytes: Buffer;
  jsonBytes: number;
  stringifyMs: number;
  compressMs: number;
}

export function serializeIndex(artifact: IndexArtifact): SerializedIndex {
  const t0 = performance.now();
  const json = Buffer.from(JSON.stringify(artifact), "utf8");
  const t1 = performance.now();
  const bytes = brotliCompressSync(json, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 6,
      [constants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });
  const t2 = performance.now();
  return { bytes, jsonBytes: json.length, stringifyMs: t1 - t0, compressMs: t2 - t1 };
}

/** Largest decoded index accepted. The largest benchmark index decodes to about 9 MB, so this leaves a wide margin while bounding a compression bomb. */
export const MAX_DECODED_INDEX_BYTES = 256 * 1024 * 1024;

export function deserializeIndex(bytes: Buffer, maxDecodedBytes = MAX_DECODED_INDEX_BYTES): { artifact: IndexArtifact; decompressMs: number; parseMs: number } {
  const t0 = performance.now();
  const json = brotliDecompressSync(bytes, { maxOutputLength: maxDecodedBytes }).toString("utf8");
  const t1 = performance.now();
  const artifact = JSON.parse(json) as IndexArtifact;
  const t2 = performance.now();
  if (artifact.version !== INDEX_VERSION) throw new Error(`Unsupported index version ${String(artifact.version)}`);
  return { artifact, decompressMs: t1 - t0, parseMs: t2 - t1 };
}
