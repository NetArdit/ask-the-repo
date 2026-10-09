/**
 * Finds where a quote sits in a listing, so the inspector can point at the exact lines a claim quoted rather than the whole
 * cited block. Matching follows the server's rule: runs of whitespace are equal, and the quote is one continuous passage.
 * Returns 1-based file line numbers, or null when the quote is not in these lines (or is too short to place).
 */
export function quotedLines(lines: readonly string[], firstLine: number, quote: string): { from: number; to: number } | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const q = norm(
    quote
      .split("\n")
      .map((l) => l.replace(/^L\d+\|\s?/, ""))
      .join(" "),
  );
  if (q.length < 3) return null;
  const parts = lines.map(norm);
  for (let start = 0; start < parts.length; start++) {
    if (parts[start] === "") continue;
    let joined = "";
    for (let end = start; end < parts.length; end++) {
      // A blank line adds nothing once whitespace is collapsed, but it still lies inside the passage.
      if (parts[end] !== "") joined = joined === "" ? parts[end]! : `${joined} ${parts[end]}`;
      const at = joined.indexOf(q);
      // The passage must begin on the first line of the window, or an earlier window would already have found it.
      if (at !== -1 && at < parts[start]!.length) return { from: firstLine + start, to: firstLine + end };
      if (joined.length > q.length + parts[start]!.length + 2) break;
    }
  }
  return null;
}
