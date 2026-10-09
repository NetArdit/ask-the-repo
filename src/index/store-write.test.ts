import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CachingSource, FsSourceCache } from "../answer/source-cache";
import { GITHUB_API_TIMEOUT_MS, fetchRepoInfo, resolveCommitSha } from "../github/client";
import { GitHubRawSource } from "../answer/source";
import { LocalFsStore } from "./store";

const KEY = { owner: "acme", repo: "shop", sha: "a".repeat(40) };
const tmpFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tmp"))
    .map((e) => e.name);

describe("LocalFsStore.put temp files", () => {
  it("survives concurrent writers of one key: the file is one writer's complete data and no temp file remains", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-"));
    const store = new LocalFsStore(dir);
    const payloads = Array.from({ length: 24 }, (_, i) => Buffer.alloc(200_000, i + 1));
    await Promise.all(payloads.map((p) => store.put(KEY, p)));
    const got = (await store.get(KEY))!;
    expect(payloads.some((p) => p.equals(got))).toBe(true);
    expect(tmpFilesUnder(dir)).toEqual([]);
  });

  it("removes its temp file and rethrows when the write cannot complete", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-"));
    mkdirSync(path.join(dir, KEY.owner, `${KEY.repo}@${KEY.sha}.idx.br`), { recursive: true }); // a directory where the file belongs
    await expect(new LocalFsStore(dir).put(KEY, Buffer.from("x"))).rejects.toThrow();
    expect(tmpFilesUnder(dir)).toEqual([]);
  });
});

describe("FsSourceCache.set temp files", () => {
  it("never corrupts a key under concurrent sets and leaves no temp file, even when a rename loses a race", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "src-cache-"));
    const cache = new FsSourceCache(dir, 10 * 1024 * 1024);
    // On Windows a rename onto a file another writer just replaced can be refused (EPERM); that is a failed write, not a corrupt one.
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => cache.set("k", { text: `v${i}`.repeat(1000), storedAt: i })));
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const got = await cache.get("k");
    expect(got?.text).toMatch(/^(v\d+)+$/);
    expect(tmpFilesUnder(dir)).toEqual([]);
  });

  it("removes its temp file and rethrows when the write cannot complete", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "src-cache-"));
    const cache = new FsSourceCache(dir, 10 * 1024 * 1024);
    await cache.set("k", { text: "v", storedAt: 1 });
    const file = readdirSync(dir, { recursive: true, withFileTypes: true }).find((e) => e.isFile() && e.name.endsWith(".json"))!;
    const target = path.join(file.parentPath, file.name);
    expect(readFileSync(target, "utf8")).toContain('"v"');
    // Replace the cache file with a directory so the final rename must fail.
    const { rmSync } = await import("node:fs");
    rmSync(target);
    mkdirSync(target);
    await expect(cache.set("k", { text: "w", storedAt: 2 })).rejects.toThrow();
    expect(tmpFilesUnder(dir)).toEqual([]);
  });
});

describe("CachingSource", () => {
  it("returns the file even when remembering it fails", async () => {
    const failing = { get: async () => null, set: async () => Promise.reject(new Error("EPERM: rename")) };
    const source = new CachingSource({ getFile: async () => "export const x = 1;\n" }, failing);
    expect(await source.getFile({ owner: "acme", repo: "shop", sha: KEY.sha }, "src/x.ts")).toBe("export const x = 1;\n");
    expect(source.stats).toMatchObject({ stores: 0, storeFailures: 1, failures: 0 });
  });
});

describe("GitHub request timeouts", () => {
  it("the file source gives every request a timeout signal", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("source text"));
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await new GitHubRawSource().getFile({ owner: "acme", repo: "shop", sha: KEY.sha }, "src/a.ts");
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(GITHUB_API_TIMEOUT_MS);
    vi.unstubAllGlobals();
    timeout.mockRestore();
  });

  it("fetchRepoInfo and resolveCommitSha forward a caller's signal to fetch", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: URL, init: RequestInit) => {
        seen.push(init.signal);
        return String(url).includes("/commits/")
          ? new Response("b".repeat(40))
          : new Response(JSON.stringify({ default_branch: "main", size: 1, private: false, archived: false, disabled: false, language: null, name: "shop", owner: { login: "acme" } }));
      }),
    );
    const signal = AbortSignal.timeout(5000);
    await fetchRepoInfo({ owner: "acme", repo: "shop" }, undefined, signal);
    await resolveCommitSha({ owner: "acme", repo: "shop" }, "main", undefined, signal);
    expect(seen).toEqual([signal, signal]);
    vi.unstubAllGlobals();
  });
});
