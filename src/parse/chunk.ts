import type { ExtractedChunk } from "./types";

export const MAX_CHUNK_LINES = 80;
export const MIN_CHUNK_LINES = 15;
export const WINDOW_LINES = 50;

export interface Unit {
  start: number;
  end: number;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Deterministic fixed-size windows. Used for markdown and whenever AST extraction fails. */
export function lineWindows(lineCount: number, size = WINDOW_LINES): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];
  for (let start = 1; start <= lineCount; start += size) {
    chunks.push({ startLine: start, endLine: Math.min(lineCount, start + size - 1) });
  }
  return chunks;
}

/** Splits an oversized unit into fixed windows so no chunk exceeds MAX_CHUNK_LINES. */
export function splitOversized(unit: Unit): Unit[] {
  const out: Unit[] = [];
  for (let start = unit.start; start <= unit.end; start += WINDOW_LINES) {
    out.push({ start, end: Math.min(unit.end, start + WINDOW_LINES - 1) });
  }
  return out;
}

/**
 * Merges syntactic units (top-level statements, class members) into chunks:
 * small neighbours are combined up to MAX_CHUNK_LINES, and the result is made
 * contiguous so every line of the file belongs to exactly one chunk.
 */
export function mergeUnits(units: Unit[], lineCount: number): ExtractedChunk[] {
  if (lineCount === 0) return [];
  const sorted = [...units].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Unit[] = [];
  for (const unit of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.end - last.start + 1 < MIN_CHUNK_LINES && unit.end - last.start + 1 <= MAX_CHUNK_LINES) {
      last.end = Math.max(last.end, unit.end);
    } else if (last && unit.start <= last.end) {
      last.end = Math.max(last.end, unit.end);
    } else {
      merged.push({ ...unit });
    }
  }
  if (merged.length === 0) return lineWindows(lineCount);
  const chunks: ExtractedChunk[] = [];
  let next = 1;
  for (let i = 0; i < merged.length; i++) {
    const unit = merged[i]!;
    const isLast = i === merged.length - 1;
    const end = isLast ? lineCount : Math.min(lineCount, unit.end);
    if (end < next) continue;
    chunks.push({ startLine: next, endLine: end });
    next = end + 1;
  }
  return chunks;
}
