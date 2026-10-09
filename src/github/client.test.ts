import { afterEach, describe, expect, it, vi } from "vitest";
import { DisallowedHostError, assertAllowedUrl, githubFetch, tarballUrl } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("assertAllowedUrl", () => {
  it.each(["https://api.github.com/repos/a/b", `https://codeload.github.com/a/b/tar.gz/${"a".repeat(40)}`])("allows %s", (u) => {
    expect(() => assertAllowedUrl(new URL(u))).not.toThrow();
  });

  it.each([
    "http://api.github.com/repos/a/b",
    "https://raw.githubusercontent.com/a/b/main/x",
    "https://github.com/a/b",
    "https://evil.com/",
    "https://api.github.com.evil.com/",
    "https://api.github.com@evil.com/",
    "https://user:pw@api.github.com/",
    "https://api.github.com:8443/",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
  ])("rejects %s", (u) => {
    expect(() => assertAllowedUrl(new URL(u))).toThrow(DisallowedHostError);
  });
});

describe("githubFetch", () => {
  it("refuses a redirect that leaves the allowlist", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.com/x" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubFetch(new URL("https://api.github.com/repos/a/b/tarball/x"))).rejects.toThrow(DisallowedHostError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows an allowed redirect and never sends the token to codeload", async () => {
    vi.stubEnv("GITHUB_TOKEN", "secret-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://codeload.github.com/a/b/tar.gz/x" } }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await githubFetch(new URL("https://api.github.com/repos/a/b/tarball/x"));
    expect(await res.text()).toBe("ok");
    const [first, second] = fetchMock.mock.calls.map((c) => c[1].headers as Record<string, string>);
    expect(first?.Authorization).toBe("Bearer secret-token");
    expect(second?.Authorization).toBeUndefined();
  });

  it("does not leak the token into error messages", async () => {
    vi.stubEnv("GITHUB_TOKEN", "secret-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));
    const err = await githubFetch(new URL("https://api.github.com/repos/a/b")).catch((e: Error) => e);
    expect(String(err)).not.toContain("secret-token");
  });
});

describe("tarballUrl", () => {
  it("is built internally and pinned to a SHA", () => {
    expect(tarballUrl({ owner: "a", repo: "b" }, "c".repeat(40)).toString()).toBe(`https://codeload.github.com/a/b/tar.gz/${"c".repeat(40)}`);
    expect(() => tarballUrl({ owner: "a", repo: "b" }, "main")).toThrow();
  });
});
