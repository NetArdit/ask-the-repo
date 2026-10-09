import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubRawSource } from "./source";
import { TEST_REPO } from "./test-helpers";

afterEach(() => vi.unstubAllGlobals());

const ok = (text: string) => new Response(text, { status: 200 });

describe("GitHubRawSource", () => {
  it("requests the file at the pinned commit through the allowlisted API host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok("const a = 1;\n"));
    vi.stubGlobal("fetch", fetchMock);
    const text = await new GitHubRawSource().getFile(TEST_REPO, "src/my file.ts");
    expect(text).toBe("const a = 1;\n");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe(`https://api.github.com/repos/acme/shop/contents/src/my%20file.ts?ref=${TEST_REPO.sha}`);
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>).Accept).toBe("application/vnd.github.raw+json");
  });

  it("caches by commit and path, and shares concurrent requests for one file", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok("x"));
    vi.stubGlobal("fetch", fetchMock);
    const s = new GitHubRawSource();
    await Promise.all([s.getFile(TEST_REPO, "a.ts"), s.getFile(TEST_REPO, "a.ts")]);
    await s.getFile(TEST_REPO, "a.ts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await s.getFile({ ...TEST_REPO, sha: "e".repeat(40) }, "a.ts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest files when the cache is over its size bound", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok("x".repeat(100)));
    vi.stubGlobal("fetch", fetchMock);
    const s = new GitHubRawSource(250);
    for (const f of ["a.ts", "b.ts", "c.ts"]) await s.getFile(TEST_REPO, f);
    await s.getFile(TEST_REPO, "a.ts");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns null for a missing file, refuses unsafe paths, and does not cache a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("nf", { status: 404 })).mockResolvedValueOnce(new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const s = new GitHubRawSource();
    expect(await s.getFile(TEST_REPO, "gone.ts")).toBeNull();
    expect(await s.getFile(TEST_REPO, "../../etc/passwd")).toBeNull();
    expect(await s.getFile(TEST_REPO, "/etc/passwd")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(s.getFile(TEST_REPO, "boom.ts")).rejects.toMatchObject({ status: 500 });
    fetchMock.mockResolvedValueOnce(ok("fine"));
    expect(await s.getFile(TEST_REPO, "boom.ts")).toBe("fine");
  });
});
