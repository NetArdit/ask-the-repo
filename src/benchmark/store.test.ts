import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpIndexStore, StoreError } from "../index/http-store";
import { startStoreServer, type StoreServerOptions } from "./store-server";

const KEY = { owner: "acme", repo: "shop", sha: "a".repeat(40) };

let server: Server | null = null;
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "atr-store-test-"));
});
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = null;
  await rm(dir, { recursive: true, force: true });
});

async function start(options: Partial<StoreServerOptions> = {}): Promise<string> {
  const s = await startStoreServer({ dir, ...options });
  server = s.server;
  return s.url;
}

describe("HttpIndexStore", () => {
  it("round-trips an artifact over HTTP", async () => {
    const store = new HttpIndexStore({ baseUrl: await start() });
    expect(await store.get(KEY)).toBeNull();
    await store.put(KEY, Buffer.from("artifact bytes"));
    expect((await store.get(KEY))?.toString()).toBe("artifact bytes");
  });

  it("sends the bearer token and surfaces 401 as a non-retryable error", async () => {
    const url = await start({ token: "secret" });
    const ok = new HttpIndexStore({ baseUrl: url, token: "secret" });
    await ok.put(KEY, Buffer.from("x"));
    const bad = new HttpIndexStore({ baseUrl: url, token: "wrong" });
    const err = await bad.get(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ status: 401, retryable: false });
    expect(String(err)).not.toContain("wrong");
  });

  it("detects a truncated download instead of returning a corrupt artifact", async () => {
    const url = await start();
    await new HttpIndexStore({ baseUrl: url }).put(KEY, Buffer.alloc(5000, 1));
    await new Promise((r) => server!.close(r));
    const truncated = await startStoreServer({ dir, truncateTo: 0.5 });
    server = truncated.server;
    const err = await new HttpIndexStore({ baseUrl: truncated.url, retries: 1 }).get(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ retryable: true });
  });

  it("times out on a slow store", async () => {
    const store = new HttpIndexStore({ baseUrl: await start({ latencyMs: 400 }), timeoutMs: 100, retries: 0 });
    await expect(store.get(KEY)).rejects.toMatchObject({ name: "StoreError", retryable: true });
  });

  it("refuses keys that could address another object", async () => {
    const store = new HttpIndexStore({ baseUrl: await start() });
    await expect(store.get({ owner: "..", repo: "x", sha: "a".repeat(40) })).rejects.toThrow();
    await expect(store.put({ owner: "a", repo: "b", sha: "../../x" }, Buffer.from("x"))).rejects.toThrow();
  });
});
