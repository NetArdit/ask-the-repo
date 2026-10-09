import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILES, TEST_REPO, buildFixture } from "../answer/test-helpers";
import { serializeIndex } from "../index/serialize";
import { LocalFsStore } from "../index/store";

let storeDir: string;
beforeEach(() => {
  vi.resetModules();
  storeDir = mkdtempSync(path.join(tmpdir(), "runtime-index-"));
  vi.stubEnv("INDEX_STORE_DIR", storeDir);
  vi.stubEnv("INDEX_STORE_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loading a stored index", () => {
  it("serves a good artifact stored under its own key", async () => {
    const { index } = await buildFixture(FILES);
    await new LocalFsStore(storeDir).put(TEST_REPO, serializeIndex(index.artifact).bytes);
    const { loadCachedIndex } = await import("./runtime");
    expect(await loadCachedIndex(TEST_REPO)).not.toBeNull();
  });

  it("treats corrupt bytes as not indexed, so the commit can be rebuilt, instead of failing it permanently", async () => {
    await new LocalFsStore(storeDir).put(TEST_REPO, Buffer.from("this is not a brotli stream"));
    const { loadCachedIndex } = await import("./runtime");
    expect(await loadCachedIndex(TEST_REPO)).toBeNull();
  });

  it("treats an artifact of another version as not indexed", async () => {
    const { index } = await buildFixture(FILES);
    await new LocalFsStore(storeDir).put(TEST_REPO, serializeIndex({ ...index.artifact, version: 1 as never }).bytes);
    const { loadCachedIndex } = await import("./runtime");
    expect(await loadCachedIndex(TEST_REPO)).toBeNull();
  });

  it("never lets an artifact that describes another repository answer for this one", async () => {
    const { index } = await buildFixture(FILES);
    await new LocalFsStore(storeDir).put(TEST_REPO, serializeIndex({ ...index.artifact, key: { ...TEST_REPO, repo: "someone-else" } }).bytes);
    const { loadCachedIndex } = await import("./runtime");
    expect(await loadCachedIndex(TEST_REPO)).toBeNull();
  });
});
