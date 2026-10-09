import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILES, TEST_REPO, buildFixture } from "../../answer/test-helpers";
import { GitHubHttpError } from "../../github/client";
import { resetGuards } from "../../server/guards";

const gh = vi.hoisted(() => ({ fetchRepoInfo: vi.fn(), resolveCommitSha: vi.fn(), githubFetch: vi.fn() }));
vi.mock("../../github/client", async (orig) => ({ ...(await orig<typeof import("../../github/client")>()), ...gh }));

const { POST: ingest } = await import("./ingest/route");
const { POST: answer } = await import("./answer/route");
const { GET: search } = await import("./search/route");
const { GET: repoStatus } = await import("./repo/route");
const { GET: source } = await import("./source/route");
const { LocalFsStore } = await import("../../index/store");
const { serializeIndex } = await import("../../index/serialize");

const SHA = "c".repeat(40);
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url: string) => new NextRequest(`http://localhost${url}`);

/** A real gzipped tarball shaped like GitHub's: one root folder, then the files. */
async function tarball(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, text] of Object.entries(files)) pack.entry({ name: `shop-${SHA}/${name}` }, text);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

let storeDir: string;
beforeEach(() => {
  resetGuards();
  storeDir = mkdtempSync(path.join(tmpdir(), "routes-store-"));
  vi.stubEnv("INDEX_STORE_DIR", storeDir);
  vi.stubEnv("INDEX_STORE_URL", "");
  gh.fetchRepoInfo.mockReset();
  gh.resolveCommitSha.mockReset();
  gh.githubFetch.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("request limits at the routes", () => {
  const CLIENT = { "x-forwarded-for": "198.51.100.20" };

  it("answers 429 with Retry-After once a client passes the ingest limit", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    gh.githubFetch.mockRejectedValue(new GitHubHttpError(404, "https://codeload.github.com/acme/shop/tar.gz/x", null));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA }, CLIENT))).status);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
    const res = await ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA }, CLIENT));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    expect(gh.githubFetch).toHaveBeenCalledTimes(6);
    // Another client is not affected by the first one's limit.
    expect((await ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA }, { "x-forwarded-for": "198.51.100.21" }))).status).toBe(404);
  });

  it("does not let junk requests use up the allowance of real ones", async () => {
    for (let i = 0; i < 60; i++) expect((await ingest(post("/api/ingest", { repo: "bad/repo/ref" }))).status).toBe(400);
    for (let i = 0; i < 60; i++) expect((await answer(post("/api/answer", { repo: "acme/shop" }))).status).toBe(400);
    gh.githubFetch.mockRejectedValue(new GitHubHttpError(404, "https://codeload.github.com/acme/shop/tar.gz/x", null));
    expect((await ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA }))).status).toBe(404);
  });

  const INSUFFICIENT = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"status":"insufficient_evidence","missing":"x"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

  /** A configured model whose HTTP reply is supplied here, and the fixture repository indexed, so a question runs the whole route. */
  async function withModel(reply: () => Response) {
    vi.stubEnv("GROQ_API_KEY", "test-key");
    vi.stubEnv("GROQ_MODEL", "test-model");
    const { index } = await buildFixture(FILES);
    await new LocalFsStore(storeDir).put(TEST_REPO, serializeIndex(index.artifact).bytes);
    gh.githubFetch.mockImplementation(async (url: URL | string) => {
      const file = Object.keys(FILES).find((p) => String(url).includes(`/contents/${p}`));
      return file ? new Response(FILES[file as keyof typeof FILES]) : new Response("", { status: 404 });
    });
    const model = vi.fn().mockImplementation(async () => reply());
    vi.stubGlobal("fetch", model);
    const ask = (headers: Record<string, string> = {}) => answer(post("/api/answer", { repo: "acme/shop", sha: TEST_REPO.sha, question: "where is loginUser implemented" }, headers));
    return { model, ask };
  }

  it("limits the answer route too: a question that reached the model uses the client's allowance, and the refused one never reaches the pipeline", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const { model, ask } = await withModel(INSUFFICIENT);
    expect((await ask(CLIENT)).status).toBe(200);
    const refused = await ask(CLIENT);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    expect(model).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not use up the allowance for a question that could not have reached the model: no model configured, or a commit not indexed here", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    // No model is configured: every such request ends at 503 and none of them counts.
    for (let i = 0; i < 5; i++) {
      const res = await answer(post("/api/answer", { repo: "acme/shop", sha: SHA, question: "q" }, CLIENT));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "no_provider" });
    }
    // A model is configured, but this commit is not indexed: 404 each time, and the model is never asked.
    const { model, ask } = await withModel(INSUFFICIENT);
    for (let i = 0; i < 5; i++) {
      const res = await answer(post("/api/answer", { repo: "acme/shop", sha: SHA, question: "q" }, CLIENT));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_indexed" });
    }
    expect(model).not.toHaveBeenCalled();
    // After all of those the client's one question is still there, and it is the only one.
    expect((await ask(CLIENT)).status).toBe(200);
    expect((await ask(CLIENT)).status).toBe(429);
    expect(model).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("after the model's own rate limit refuses a question, pauses answers for the wait it stated without asking it again, and does not count the refused call", async () => {
    vi.stubEnv("ANSWERS_PER_DAY", "1");
    let t = 0;
    resetGuards(() => t);
    const { model, ask } = await withModel(() => new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "30" } }));

    const first = await ask();
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("30");
    expect(await first.json()).toMatchObject({ status: "provider_error", reasons: ["model provider failed: rate_limited"] });
    expect(model).toHaveBeenCalledTimes(1);

    const paused = await ask();
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("30");
    expect(await paused.json()).toMatchObject({ code: "model_cooldown", retryAfterSeconds: 30 });
    expect(model).toHaveBeenCalledTimes(1); // the model was not asked again

    // Once the wait is over the question goes through, and the day's single answer is still available: the refused call was not counted.
    t += 30_000;
    model.mockImplementation(async () => INSUFFICIENT());
    const served = await ask();
    expect(served.status).toBe(200);
    expect(model).toHaveBeenCalledTimes(2);
    t += 2 * 60_000;
    expect(await (await ask()).json()).toMatchObject({ code: "daily_limit" });
    vi.unstubAllGlobals();
  });

  it("refuses an oversized body with 413 on both POST routes", async () => {
    const big = JSON.stringify({ repo: "acme/shop", sha: SHA, question: "x".repeat(20_000) });
    const a = await answer(post("/api/answer", big));
    expect(a.status).toBe(413);
    expect(await a.json()).toEqual({ error: "request body too large" });
    expect((await ingest(post("/api/ingest", big))).status).toBe(413);
  });

  it("refuses a POST that is not application/json before it can use any allowance (a cross-site form or text/plain post)", async () => {
    const body = JSON.stringify({ repo: "acme/shop", sha: SHA, question: "q" });
    for (const [route, handler] of [["/api/answer", answer], ["/api/ingest", ingest]] as const) {
      for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
        const res = await handler(post(route, body, { "content-type": type }));
        expect(res.status).toBe(415);
      }
    }
    expect((await answer(post("/api/answer", body, { "content-type": "application/json; charset=utf-8" }))).status).not.toBe(415);
  });

  it("limits the read routes", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await search(new NextRequest("http://localhost/api/search", { headers: CLIENT }))).status;
    expect(last).toBe(429);
  });
});

describe("/api/ingest reuse", () => {
  it("builds once for identical concurrent requests, then serves the stored index without downloading again", async () => {
    const body = await tarball({ "src/a.ts": "export function alpha() {\n  return 1;\n}\n", "README.md": "# Shop\n\nSome text.\n" });
    gh.githubFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response(new Uint8Array(body));
    });
    const [a, b] = await Promise.all([ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA })), ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA }))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(gh.githubFetch).toHaveBeenCalledTimes(1);
    const first = await a.json();
    expect(first).toMatchObject({ sha: SHA, files: 2, cached: false });

    const again = await ingest(post("/api/ingest", { repo: "acme/shop", sha: SHA }));
    expect(await again.json()).toMatchObject({ sha: SHA, files: 2, cached: true });
    expect(gh.githubFetch).toHaveBeenCalledTimes(1);
    expect(gh.fetchRepoInfo).not.toHaveBeenCalled(); // a pinned commit needs no GitHub API call at all
  });
});

describe("/api/ingest latest-commit lookups", () => {
  it("looks up the latest commit once when a repository is opened again moments later", async () => {
    const body = await tarball({ "src/a.ts": "export const a = 1;\n" });
    gh.fetchRepoInfo.mockResolvedValue({ defaultBranch: "main" });
    gh.resolveCommitSha.mockResolvedValue(SHA);
    gh.githubFetch.mockImplementation(async () => new Response(new Uint8Array(body)));
    const first = await ingest(post("/api/ingest", { repo: "acme/lookup" }));
    const second = await ingest(post("/api/ingest", { repo: "Acme/Lookup" }));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await second.json()).toMatchObject({ sha: SHA, cached: true });
    expect(gh.fetchRepoInfo).toHaveBeenCalledTimes(1);
    expect(gh.resolveCommitSha).toHaveBeenCalledTimes(1);
  });
});

describe("/api/repo and /api/source", () => {
  it("reports an unindexed commit, then a summary and source lines once the index exists", async () => {
    expect((await repoStatus(get(`/api/repo?repo=acme/shop&sha=${TEST_REPO.sha}`))).status).toBe(404);
    const { index } = await buildFixture(FILES);
    await new LocalFsStore(storeDir).put(TEST_REPO, serializeIndex(index.artifact).bytes);

    const status = await repoStatus(get(`/api/repo?repo=acme/shop&sha=${TEST_REPO.sha}`));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ repo: "acme/shop", files: 3, languages: { typescript: 3 } });

    // The file text comes from GitHub; here the one request the route makes is answered locally.
    gh.githubFetch.mockResolvedValue(new Response(FILES["src/util/crypto.ts"]));
    const res = await source(get(`/api/source?repo=acme/shop&sha=${TEST_REPO.sha}&path=src/util/crypto.ts&start=1&end=3`));
    expect(res.status).toBe(200);
    const excerpt = await res.json();
    expect(excerpt.lines[0]).toBe("export function hashPassword(input: string): string {");
    expect(excerpt.url).toContain(`/blob/${TEST_REPO.sha}/src/util/crypto.ts#L1-L3`);
    expect(String(gh.githubFetch.mock.calls[0]![0])).toContain("api.github.com/repos/acme/shop/contents/src/util/crypto.ts");

    const outside = await source(get(`/api/source?repo=acme/shop&sha=${TEST_REPO.sha}&path=.env&start=1&end=3`));
    expect(outside.status).toBe(404);
    expect(gh.githubFetch).toHaveBeenCalledTimes(1);
  });

  it("reads and decodes a cold index once for simultaneous requests", async () => {
    const { index } = await buildFixture(FILES);
    const key = { ...TEST_REPO, repo: "cold" };
    await new LocalFsStore(storeDir).put(key, serializeIndex({ ...index.artifact, key }).bytes);
    const reads = vi.spyOn(LocalFsStore.prototype, "get");
    const url = `/api/repo?repo=acme/cold&sha=${TEST_REPO.sha}`;
    const all = await Promise.all([repoStatus(get(url)), repoStatus(get(url)), repoStatus(get(url)), repoStatus(get(url))]);
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed source requests with 400", async () => {
    expect((await source(get(`/api/source?repo=acme/shop&sha=${TEST_REPO.sha}&path=../x&start=1&end=2`))).status).toBe(400);
    expect((await source(get(`/api/source?repo=acme/shop&sha=main&path=a.ts&start=1&end=2`))).status).toBe(400);
  });
});
