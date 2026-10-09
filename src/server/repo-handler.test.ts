import { describe, expect, it, vi } from "vitest";
import { MapSource } from "../answer/source";
import { FILES, TEST_REPO, buildFixture } from "../answer/test-helpers";
import { GitHubHttpError } from "../github/client";
import { MAX_LINE_CHARS, MAX_SOURCE_LINES, handleRepoStatus, handleSource, parseSourceParams, summarizeIndex, type SourceExcerpt } from "./repo-handler";

const q = (o: Record<string, string>) => new URLSearchParams({ repo: "acme/shop", sha: TEST_REPO.sha, ...o });

describe("summarizeIndex / handleRepoStatus", () => {
  it("describes an index with counts only, never source text", async () => {
    const { index } = await buildFixture(FILES);
    const s = summarizeIndex(index);
    expect(s).toMatchObject({ repo: "acme/shop", sha: TEST_REPO.sha, files: 3, languages: { typescript: 3 } });
    expect(s.chunks).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain("hashPassword(password)");
  });

  it("answers 200 with the summary, 404 when not indexed, 400 for bad input, and a clean 500 when the store fails", async () => {
    const { index } = await buildFixture(FILES);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await handleRepoStatus(async () => index, q({}))).status).toBe(200);
    expect(await handleRepoStatus(async () => null, q({}))).toEqual({ status: 404, body: { error: "index not found for this commit", code: "not_indexed" } });
    expect((await handleRepoStatus(async () => index, new URLSearchParams({ repo: "../../etc", sha: TEST_REPO.sha }))).status).toBe(400);
    expect((await handleRepoStatus(async () => index, new URLSearchParams({ repo: "acme/shop", sha: "main" }))).status).toBe(400);
    const failed = await handleRepoStatus(async () => {
      throw new Error("EACCES: open 'C:\\secret\\x'");
    }, q({}));
    expect(failed).toEqual({ status: 500, body: { error: "internal error" } });
    errors.mockRestore();
  });
});

describe("parseSourceParams", () => {
  it.each([
    [{ path: "src/a.ts", start: "1" }, "missing end"],
    [{ path: "../secret", start: "1", end: "2" }, "traversal"],
    [{ path: "/etc/passwd", start: "1", end: "2" }, "absolute"],
    [{ path: "src\\a.ts", start: "1", end: "2" }, "backslash"],
    [{ path: "src/a.ts", start: "0", end: "2" }, "line 0"],
    [{ path: "src/a.ts", start: "1e3", end: "2000" }, "not an integer"],
    [{ path: "src/a.ts", start: "-1", end: "2" }, "negative"],
    [{ path: "src/a.ts", start: "5", end: "4" }, "reversed"],
    [{ path: "src/a.ts", start: "1", end: String(MAX_SOURCE_LINES + 1) }, "too many lines"],
  ] as [Record<string, string>, string][])("rejects %j (%s)", (params) => {
    expect(() => parseSourceParams(q(params))).toThrow();
  });

  it("accepts a normal range", () => {
    expect(parseSourceParams(q({ path: "src/auth/login.ts", start: "3", end: "6" }))).toMatchObject({ path: "src/auth/login.ts", start: 3, end: 6 });
  });
});

describe("handleSource", () => {
  it("returns exactly the requested lines with a server-built permalink", async () => {
    const { index, source } = await buildFixture(FILES);
    const res = await handleSource({ loadIndex: async () => index, source }, q({ path: "src/auth/login.ts", start: "3", end: "6" }));
    expect(res.status).toBe(200);
    const body = res.body as SourceExcerpt;
    expect(body.lines).toEqual(FILES["src/auth/login.ts"]!.split("\n").slice(2, 6));
    expect(body).toMatchObject({ startLine: 3, endLine: 6, lineCount: FILES["src/auth/login.ts"]!.split("\n").length, truncatedLines: 0 });
    expect(body.url).toBe(`https://github.com/acme/shop/blob/${TEST_REPO.sha}/src/auth/login.ts#L3-L6`);
  });

  it("clamps the end to the file and rejects a start beyond it", async () => {
    const { index, source } = await buildFixture(FILES);
    const deps = { loadIndex: async () => index, source };
    const clamped = (await handleSource(deps, q({ path: "src/util/crypto.ts", start: "2", end: "300" }))).body as SourceExcerpt;
    expect(clamped.endLine).toBe(clamped.lineCount);
    expect((await handleSource(deps, q({ path: "src/util/crypto.ts", start: "50", end: "60" }))).status).toBe(400);
  });

  it("serves only files that are part of the index, so it is not a general GitHub proxy", async () => {
    const { index } = await buildFixture(FILES);
    const getFile = vi.fn().mockResolvedValue("secret");
    const res = await handleSource({ loadIndex: async () => index, source: { getFile } }, q({ path: ".env", start: "1", end: "5" }));
    expect(res).toEqual({ status: 404, body: { error: "that file is not part of this index", code: "not_in_index" } });
    expect(getFile).not.toHaveBeenCalled();
  });

  it("reports an unindexed commit, a missing file, a rate-limited source and an internal failure distinctly", async () => {
    const { index } = await buildFixture(FILES);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = q({ path: "src/util/crypto.ts", start: "1", end: "2" });
    expect((await handleSource({ loadIndex: async () => null, source: new MapSource(new Map()) }, p)).status).toBe(404);
    expect(await handleSource({ loadIndex: async () => index, source: new MapSource(new Map()) }, p)).toMatchObject({ status: 404, body: { code: "source_unavailable" } });
    const limited = { getFile: async () => Promise.reject(new GitHubHttpError(403, "https://api.github.com/x", "0")) };
    expect(await handleSource({ loadIndex: async () => index, source: limited }, p)).toMatchObject({ status: 503, body: { code: "source_rate_limited" } });
    const broken = { getFile: async () => Promise.reject(new Error("ECONNRESET at C:\\secret\\path")) };
    expect(await handleSource({ loadIndex: async () => index, source: broken }, p)).toEqual({ status: 500, body: { error: "internal error" } });
    errors.mockRestore();
  });

  it("cuts a very long line for display and says how many were cut", async () => {
    const files = { "src/long.ts": `export const data = "${"x".repeat(MAX_LINE_CHARS * 2)}";\nexport const ok = 1;\n` };
    const { index, source } = await buildFixture(files);
    const body = (await handleSource({ loadIndex: async () => index, source }, q({ path: "src/long.ts", start: "1", end: "2" }))).body as SourceExcerpt;
    expect(body.lines[0]!.length).toBe(MAX_LINE_CHARS);
    expect(body.truncatedLines).toBe(1);
    expect(body.lines[1]).toBe("export const ok = 1;");
  });
});
