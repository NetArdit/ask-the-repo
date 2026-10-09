import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, LimitExceededError, ingestTarGz, type IngestLimits, type IngestedFile } from "./tarball";

interface Entry {
  name: string;
  body?: string | Buffer;
  type?: "file" | "symlink" | "directory";
  linkname?: string;
}

async function makeTarGz(entries: Entry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: unknown) => chunks.push(c as Buffer));
  const done = new Promise<void>((resolve) => pack.on("end", resolve));
  for (const e of entries) {
    const body = e.body ?? "";
    const isFile = e.type === undefined || e.type === "file";
    await new Promise<void>((resolve, reject) =>
      pack.entry({ name: e.name, type: e.type ?? "file", linkname: e.linkname, size: isFile ? Buffer.byteLength(body) : 0 }, isFile ? body : "", (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  }
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

async function run(entries: Entry[], limits: Partial<IngestLimits> = {}) {
  const files: IngestedFile[] = [];
  const archive = await makeTarGz(entries);
  const stats = await ingestTarGz(Readable.from([archive]), { ...DEFAULT_LIMITS, ...limits }, (f) => void files.push(f));
  return { files, stats };
}

describe("ingestTarGz", () => {
  it("strips the archive root and delivers code files", async () => {
    const { files, stats } = await run([
      { name: "repo-abc/", type: "directory" },
      { name: "repo-abc/src/a.ts", body: "export const a = 1;\n" },
      { name: "repo-abc/README.md", body: "# hi\n" },
    ]);
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts"]);
    expect(stats.delivered).toBe(2);
  });

  it("rejects traversal and absolute entry names without delivering them", async () => {
    const { files, stats } = await run([
      { name: "repo-abc/../../evil.ts", body: "x" },
      { name: "repo-abc//etc/passwd.ts", body: "x" },
      { name: "repo-abc/a/../../b.ts", body: "x" },
      { name: "repo-abc/ok.ts", body: "x" },
    ]);
    expect(files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(Object.values(stats.rejectedPaths).reduce((a, b) => a + (b ?? 0), 0)).toBe(3);
  });

  it("ignores symlinks instead of following them", async () => {
    const { files, stats } = await run([
      { name: "repo-abc/link.ts", type: "symlink", linkname: "/etc/passwd" },
      { name: "repo-abc/ok.ts", body: "x" },
    ]);
    expect(files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(stats.nonFileEntries).toBe(1);
  });

  it("skips vendored, lockfile, minified, binary, generated and oversized files", async () => {
    const { files, stats } = await run(
      [
        { name: "repo-abc/node_modules/x/index.js", body: "x" },
        { name: "repo-abc/vendor/y.ts", body: "x" },
        { name: "repo-abc/package-lock.json", body: "{}" },
        { name: "repo-abc/app.min.js", body: "x" },
        { name: "repo-abc/logo.png", body: "x" },
        { name: "repo-abc/big.ts", body: "x".repeat(20_000) },
        { name: "repo-abc/blob.ts", body: Buffer.from([0x61, 0, 0x62]) },
        { name: "repo-abc/gen.ts", body: "// @generated\nexport {}\n" },
        { name: "repo-abc/long.js", body: `var a="${"y".repeat(4000)}";` },
        { name: "repo-abc/ok.ts", body: "export {}\n" },
      ],
      { maxFileBytes: 10_000 },
    );
    expect(files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(stats.skipped).toMatchObject({
      vendored: 2,
      lockfile: 1,
      "minified-name": 1,
      "binary-extension": 1,
      "too-large": 1,
      "binary-content": 1,
      generated: 1,
      "minified-content": 1,
    });
  });

  it("aborts when the entry count is exceeded", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ name: `repo-abc/f${i}.ts`, body: "x" }));
    await expect(run(entries, { maxEntries: 10 })).rejects.toMatchObject({ name: "LimitExceededError", kind: "entries" });
  });

  it("aborts a decompression bomb on uncompressed size while streaming", async () => {
    const bomb = Buffer.alloc(30 * 1024 * 1024, 0x61);
    const archive = await makeTarGz([{ name: "repo-abc/bomb.txt", body: bomb }]);
    expect(archive.length).toBeLessThan(200_000);
    const err = await ingestTarGz(Readable.from([archive]), { ...DEFAULT_LIMITS, maxUncompressedBytes: 1024 * 1024 }, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect(err).toMatchObject({ kind: "uncompressed-bytes" });
  });

  it("aborts when compressed bytes exceed the cap", async () => {
    const noise = randomBytes(5000);
    const archive = await makeTarGz([{ name: "repo-abc/a.ts", body: noise }]);
    const err = await ingestTarGz(Readable.from([archive]), { ...DEFAULT_LIMITS, maxCompressedBytes: 1000 }, () => {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LimitExceededError", kind: "compressed-bytes" });
  });

  it("aborts a stalled download on the total-time limit", async () => {
    const stalled = new Readable({ read() {} });
    const err = await ingestTarGz(stalled, { ...DEFAULT_LIMITS, maxTotalMs: 150 }, () => {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LimitExceededError", kind: "total-time" });
  });

  it("survives hostile file names", async () => {
    const names = ["a\nb.ts", "<script>alert(1)</script>.ts", "emoji-😀.ts", `${"d/".repeat(300)}x.ts`, "con.ts", " .ts", "a‮b.ts"];
    const { files } = await run(names.map((n) => ({ name: `repo-abc/${n}`, body: "export {}\n" })));
    for (const f of files) {
      expect(f.path.startsWith("/")).toBe(false);
      expect(f.path.split("/")).not.toContain("..");
    }
  });

  it("fails cleanly on a corrupt archive", async () => {
    const err = await ingestTarGz(Readable.from([Buffer.from("this is not gzip")]), DEFAULT_LIMITS, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
