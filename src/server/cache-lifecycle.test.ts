import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalFsStore } from "../index/store";
import { BoundedStore } from "./bounded-store";
import { LatestCommitCache } from "./latest-commit";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("LatestCommitCache", () => {
  it("asks GitHub once within the lifetime of an entry and again after it expires", async () => {
    let t = 0;
    const cache = new LatestCommitCache(60_000, 10, () => t);
    const resolve = vi.fn().mockResolvedValueOnce(SHA_A).mockResolvedValueOnce(SHA_B);
    expect(await cache.get("acme", "shop", resolve)).toBe(SHA_A);
    t += 59_999;
    expect(await cache.get("acme", "shop", resolve)).toBe(SHA_A);
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 1;
    expect(await cache.get("acme", "shop", resolve)).toBe(SHA_B);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("treats different spellings of one repository as one entry, and different repositories as different", async () => {
    const cache = new LatestCommitCache(60_000, 10, () => 0);
    const resolve = vi.fn().mockResolvedValue(SHA_A);
    await cache.get("Acme", "Shop", resolve);
    await cache.get("acme", "shop", resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    await cache.get("acme", "other", resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup between simultaneous requests and never remembers a failure", async () => {
    const cache = new LatestCommitCache(60_000, 10, () => 0);
    let release!: (sha: string) => void;
    const slow = vi.fn().mockReturnValue(new Promise<string>((r) => (release = r)));
    const both = Promise.all([cache.get("acme", "shop", slow), cache.get("acme", "shop", slow)]);
    release(SHA_A);
    expect(await both).toEqual([SHA_A, SHA_A]);
    expect(slow).toHaveBeenCalledTimes(1);

    const failing = vi.fn().mockRejectedValueOnce(new Error("GitHub 404")).mockResolvedValueOnce(SHA_B);
    await expect(cache.get("acme", "gone", failing)).rejects.toThrow("GitHub 404");
    expect(await cache.get("acme", "gone", failing)).toBe(SHA_B);
  });

  it("never holds more entries than its bound", async () => {
    const cache = new LatestCommitCache(60_000, 3, () => 0);
    const resolve = vi.fn().mockResolvedValue(SHA_A);
    for (let i = 0; i < 10; i++) await cache.get("acme", `repo-${i}`, resolve);
    await cache.get("acme", "repo-9", resolve);
    expect(resolve).toHaveBeenCalledTimes(10); // the newest is still there
    await cache.get("acme", "repo-0", resolve);
    expect(resolve).toHaveBeenCalledTimes(11); // the oldest was dropped
  });
});

describe("BoundedStore", () => {
  const key = (n: number) => ({ owner: "acme", repo: `repo-${n}`, sha: SHA_A });
  const indexFiles = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".idx.br")).map((e) => e.name);

  it("removes the oldest indexes once the folder passes its limit, and keeps the rest readable", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bounded-"));
    const store = new BoundedStore(new LocalFsStore(dir), dir, 2500);
    for (let n = 1; n <= 4; n++) {
      await store.put(key(n), Buffer.alloc(1000, n));
      await store.settled();
      // Make write order unambiguous on file systems with coarse timestamps.
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, n));
      utimesSync(path.join(dir, "acme", `repo-${n}@${SHA_A}.idx.br`), stamp, stamp);
    }
    await store.put(key(5), Buffer.alloc(1000, 5));
    await store.settled();
    const left = indexFiles(dir);
    expect(left.length).toBe(2);
    expect(await store.get(key(1))).toBeNull();
    expect((await store.get(key(5)))?.[0]).toBe(5);
  });

  it("keeps the index that was just written even when it alone is over the limit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bounded-"));
    const store = new BoundedStore(new LocalFsStore(dir), dir, 10);
    await store.put(key(1), Buffer.alloc(5000, 1));
    await store.settled();
    expect(indexFiles(dir)).toHaveLength(1);
  });

  it("does not fail a write when the clean-up cannot run", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), "bounded-"));
    const inner = new LocalFsStore(dir);
    // The sweep is pointed at a path that is a file, so listing it fails.
    await inner.put(key(1), Buffer.from("x"));
    const store = new BoundedStore(inner, path.join(dir, "acme", `repo-1@${SHA_A}.idx.br`, "nope"), 1);
    await expect(store.put(key(2), Buffer.from("y"))).resolves.toBeUndefined();
    await store.settled();
    expect((await store.get(key(2)))?.toString()).toBe("y");
    errors.mockRestore();
  });
});
