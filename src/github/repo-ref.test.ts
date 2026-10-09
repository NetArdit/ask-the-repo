import { describe, expect, it } from "vitest";
import { assertCommitSha, parseRepoRef } from "./repo-ref";

describe("parseRepoRef", () => {
  it.each([
    ["sindresorhus/ky", "sindresorhus", "ky"],
    ["github.com/expressjs/express", "expressjs", "express"],
    ["  vercel/next.js ", "vercel", "next.js"],
    ["a/b_c-d.e", "a", "b_c-d.e"],
  ])("accepts %s", (input, owner, repo) => {
    expect(parseRepoRef(input)).toEqual({ owner, repo });
  });

  it.each([
    "https://github.com/a/b",
    "http://github.com/a/b",
    "git@github.com:a/b.git",
    "github.com.evil.com/a/b",
    "evil.com/a/b",
    "a/b/c",
    "a",
    "",
    "/a/b",
    "a//b",
    "a/..",
    "../b",
    "a/b.git",
    "a/b?x=1",
    "a/b#frag",
    "a/b\nc",
    "a b/c",
    "-a/b",
    "a/b%2f..",
    "a/b\\c",
    "a/‮b",
    `${"x".repeat(40)}/b`,
    `a/${"y".repeat(101)}`,
    "github.com/",
    "www.github.com/a/b",
  ])("rejects %j", (input) => {
    expect(() => parseRepoRef(input)).toThrow();
  });
});

describe("assertCommitSha", () => {
  it("requires 40 lowercase hex characters", () => {
    expect(assertCommitSha("a".repeat(40))).toBe("a".repeat(40));
    expect(() => assertCommitSha("main")).toThrow();
    expect(() => assertCommitSha("A".repeat(40))).toThrow();
    expect(() => assertCommitSha("../".repeat(14))).toThrow();
  });
});
