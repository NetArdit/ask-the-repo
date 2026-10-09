import { describe, expect, it } from "vitest";
import { normalizeArchivePath, stripArchiveRoot } from "./paths";

describe("normalizeArchivePath", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src//a.ts", "src/a.ts"],
    ["src/./a.ts", "src/a.ts"],
    ["dir/", "dir"],
    ["weird name/ünï.ts", "weird name/ünï.ts"],
  ])("accepts %j", (raw, expected) => {
    expect(normalizeArchivePath(raw)).toEqual({ ok: true, path: expected });
  });

  it.each([
    ["../x", "traversal"],
    ["a/../../x", "traversal"],
    ["a/..", "traversal"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/x", "absolute"],
    ["c:\\x", "backslash"],
    ["c:x", "absolute"],
    ["a\\b", "backslash"],
    ["a\0b", "null-byte"],
    ["", "empty"],
    ["x".repeat(401), "too-long"],
  ])("rejects %j as %s", (raw, reason) => {
    expect(normalizeArchivePath(raw)).toEqual({ ok: false, reason });
  });
});

describe("stripArchiveRoot", () => {
  it("removes the single leading directory", () => {
    expect(stripArchiveRoot("repo-abc123/src/a.ts")).toBe("src/a.ts");
    expect(stripArchiveRoot("pax_global_header")).toBeNull();
  });
});
