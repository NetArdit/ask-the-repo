import { createHash } from "node:crypto";

/**
 * Integrity fingerprint of a block of source lines. The index stores this instead of the text, so a later
 * re-fetch of the same commit can be checked against what was indexed without the index containing source.
 */
export function hashLines(lines: readonly string[]): string {
  return createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 12);
}

/** Splits file text exactly the way the indexer does, so line numbers and hashes agree. */
export function splitLines(text: string): string[] {
  return text.split("\n");
}
