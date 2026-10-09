import { describe, expect, it } from "vitest";
import { BadRequestError, MAX_QUESTION_LENGTH, parseIngestBody, parseSearchParams } from "./validate";

const SHA = "a".repeat(40);
const qs = (o: Record<string, string>) => new URLSearchParams(o);

describe("parseSearchParams", () => {
  it("accepts a well-formed request", () => {
    expect(parseSearchParams(qs({ repo: "a/b", sha: SHA, q: "where is x" }))).toMatchObject({ ref: { owner: "a", repo: "b" }, sha: SHA });
  });

  it.each([
    {},
    { repo: "a/b", sha: SHA },
    { repo: "https://evil.com/a/b", sha: SHA, q: "x" },
    { repo: "a/b", sha: "main", q: "x" },
    { repo: "a/b", sha: SHA, q: "x".repeat(MAX_QUESTION_LENGTH + 1) },
  ])("rejects %j", (o) => {
    expect(() => parseSearchParams(qs(o as Record<string, string>))).toThrow(BadRequestError);
  });
});

describe("parseIngestBody", () => {
  it("accepts a repo with or without a pinned commit", () => {
    expect(parseIngestBody({ repo: "a/b" }).sha).toBeNull();
    expect(parseIngestBody({ repo: "a/b", sha: SHA }).sha).toBe(SHA);
  });

  it.each([null, "x", {}, { repo: 3 }, { repo: "a/b/c" }, { repo: "a/b", sha: "../x" }])("rejects %j", (b) => {
    expect(() => parseIngestBody(b)).toThrow(BadRequestError);
  });
});
