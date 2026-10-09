import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILES, TEST_REPO, buildFixture } from "../../answer/test-helpers";
import { GITHUB_API_TIMEOUT_MS, GitHubHttpError, PrivateRepositoryError } from "../../github/client";
import { DEFAULT_LIMITS } from "../../ingest/tarball";
import { resetGuards } from "../../server/guards";
import { latestCommits } from "../../server/runtime";

const gh = vi.hoisted(() => ({ fetchRepoInfo: vi.fn(), resolveCommitSha: vi.fn(), githubFetch: vi.fn() }));
vi.mock("../../github/client", async (orig) => ({ ...(await orig<typeof import("../../github/client")>()), ...gh }));

const rt = vi.hoisted(() => ({ loadCachedIndex: vi.fn() }));
vi.mock("../../server/runtime", async (orig) => ({ ...(await orig<typeof import("../../server/runtime")>()), ...rt }));

const { POST: ingest } = await import("./ingest/route");
const { GET: search } = await import("./search/route");
const { POST: answer } = await import("./answer/route");

const SECRET_PATH = "C:\\very\\secret\\store\\path.idx.br";
const SHA = "a".repeat(40);
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetGuards();
  latestCommits.clear();
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  gh.fetchRepoInfo.mockReset();
  gh.resolveCommitSha.mockReset();
  gh.githubFetch.mockReset();
  rt.loadCachedIndex.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("/api/ingest error mapping and sanitising", () => {
  it.each([
    [new GitHubHttpError(404, "https://api.github.com/repos/a/b", null), 404, "repository or commit not found"],
    [new GitHubHttpError(403, "https://api.github.com/repos/a/b", "0"), 503, "GitHub rate limit reached; retry later"],
    [new GitHubHttpError(429, "https://api.github.com/repos/a/b", null), 503, "GitHub rate limit reached; retry later"],
    [new GitHubHttpError(409, "https://api.github.com/repos/a/b/commits/main", null), 422, "repository cannot be indexed (for example, it has no commits)"],
    [new PrivateRepositoryError(), 404, "Private repositories are not supported"],
  ])("maps %s to %i", async (err, status, message) => {
    gh.fetchRepoInfo.mockRejectedValue(err);
    const res = await ingest(post("/api/ingest", { repo: "a/b" }));
    expect(res.status).toBe(status);
    // Some mappings also carry a machine-readable code; the message is what a person reads.
    expect(await res.json()).toMatchObject({ error: message });
  });

  it("keeps validation errors as 400", async () => {
    const res = await ingest(post("/api/ingest", { repo: "a/b/c" }));
    expect(res.status).toBe(400);
  });

  it.each([
    new Error(`ENOENT: no such file or directory, open '${SECRET_PATH}'`),
    new Error("Set INDEX_STORE_URL or INDEX_STORE_DIR"),
    new GitHubHttpError(500, "https://api.github.com/repos/a/b", null),
  ])("returns a generic 500 for %s and logs the detail server-side", async (err) => {
    gh.fetchRepoInfo.mockRejectedValue(err);
    const res = await ingest(post("/api/ingest", { repo: "a/b" }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("INDEX_STORE");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain(err.message);
  });

  it("puts a timeout signal on every GitHub request it makes", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    gh.fetchRepoInfo.mockResolvedValue({ defaultBranch: "main" });
    gh.resolveCommitSha.mockResolvedValue(SHA);
    gh.githubFetch.mockRejectedValue(new GitHubHttpError(404, "https://codeload.github.com/a/b/tar.gz/x", null));
    await ingest(post("/api/ingest", { repo: "a/b" }));
    expect(gh.fetchRepoInfo.mock.calls[0]![2]).toBeInstanceOf(AbortSignal);
    expect(gh.resolveCommitSha.mock.calls[0]![3]).toBeInstanceOf(AbortSignal);
    expect(gh.githubFetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    const ms = timeout.mock.calls.map((c) => c[0]);
    expect(ms).toContain(GITHUB_API_TIMEOUT_MS);
    expect(ms).toContain(DEFAULT_LIMITS.maxTotalMs);
  });
});

describe("/api/search", () => {
  const url = `/api/search?repo=a/b&sha=${SHA}&q=where%20is%20loginUser`;

  it("returns a generic 500 and logs the detail when the store fails", async () => {
    rt.loadCachedIndex.mockRejectedValue(new Error(`EACCES: permission denied, open '${SECRET_PATH}'`));
    const res = await search(new NextRequest(`http://localhost${url}`));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
    expect(text).not.toContain(SECRET_PATH);
    expect(String(errors.mock.calls[0]![0])).toContain(SECRET_PATH);
  });

  it("omits process internals in production and keeps them for development", async () => {
    const { index } = await buildFixture(FILES);
    rt.loadCachedIndex.mockResolvedValue({ index, timings: { warmIndex: true, fetchMs: 0, deserializeMs: 0, deriveMs: 0 } });
    vi.stubEnv("NODE_ENV", "production");
    const prod = await (await search(new NextRequest(`http://localhost${url}`))).json();
    expect(prod.evidence).toBeDefined();
    expect(prod).not.toHaveProperty("process");
    expect(JSON.stringify(prod)).not.toMatch(/rssMb|heapUsedMb|uptimeMs|"node"/);
    vi.stubEnv("NODE_ENV", "development");
    const dev = await (await search(new NextRequest(`http://localhost${url}`))).json();
    expect(dev.process).toMatchObject({ node: expect.any(String), rssMb: expect.any(Number) });
  });
});

describe("/api/answer", () => {
  it("returns a generic 500 when the index store is misconfigured, without leaking the configuration hint", async () => {
    rt.loadCachedIndex.mockRejectedValue(new Error("Set INDEX_STORE_URL or INDEX_STORE_DIR"));
    vi.stubEnv("GROQ_API_KEY", "gsk_test_key_not_real");
    vi.stubEnv("GROQ_MODEL", "some/model");
    const res = await answer(post("/api/answer", { repo: "a/b", sha: TEST_REPO.sha, question: "where is loginUser" }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
    expect(text).not.toContain("INDEX_STORE");
    expect(text).not.toContain("gsk_test_key_not_real");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).not.toContain("gsk_test_key_not_real");
  });
});
