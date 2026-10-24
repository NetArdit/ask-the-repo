import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { BROAD_MAX_FILES, BROAD_MAX_FILE_BYTES, broadLanguageOf, classifyPath, languageOf } from "./filter";
import { DEFAULT_LIMITS, ingestTarGz, type IngestedFile } from "./tarball";

async function makeTarGz(entries: { name: string; body: string }[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: unknown) => chunks.push(c as Buffer));
  const done = new Promise<void>((resolve) => pack.on("end", resolve));
  for (const e of entries) {
    await new Promise<void>((resolve, reject) => pack.entry({ name: e.name, size: Buffer.byteLength(e.body) }, e.body, (err) => (err ? reject(err) : resolve())));
  }
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

async function ingest(entries: { name: string; body: string }[], broad: boolean) {
  const files: IngestedFile[] = [];
  const stats = await ingestTarGz(Readable.from([await makeTarGz(entries)]), DEFAULT_LIMITS, (f) => void files.push(f), { includeConfig: true, broad });
  return { files, stats };
}

describe("broad file reading: path rules", () => {
  it("leaves the default exactly as it was: only JavaScript, TypeScript and Markdown are read", () => {
    expect(classifyPath("app/main.py")).toBe("unsupported-extension");
    expect(classifyPath("site/index.html")).toBe("unsupported-extension");
    expect(classifyPath("src/a.ts")).toBeNull();
    expect(classifyPath("README.md")).toBeNull();
    expect(languageOf("app/main.py")).toBe("other");
  });

  it("reads other text files in broad mode, in any folder", () => {
    for (const p of ["app/main.py", "site/index.html", "styles/app.css", "src/Main.java", "cmd/server/main.go", "Dockerfile", "deploy/run.sh", "config/app.yml", "a/b/c/d/e/deep.rb"]) {
      expect(classifyPath(p, { broad: true }), p).toBeNull();
    }
  });

  it("still skips vendored, data, licence, minified and binary files in broad mode", () => {
    expect(classifyPath("node_modules/x/index.js", { broad: true })).toBe("vendored");
    expect(classifyPath(".venv/lib/site.py", { broad: true })).toBe("vendored");
    expect(classifyPath("target/classes/Main.java", { broad: true })).toBe("vendored");
    expect(classifyPath("data/rows.csv", { broad: true })).toBe("unsupported-extension");
    expect(classifyPath("assets/logo.svg", { broad: true })).toBe("unsupported-extension");
    expect(classifyPath("LICENSE", { broad: true })).toBe("unsupported-extension");
    expect(classifyPath("static/app.min.js", { broad: true })).toBe("minified-name");
    expect(classifyPath("img/photo.png", { broad: true })).toBe("binary-extension");
    expect(classifyPath("poetry.lock", { broad: true })).toBe("unsupported-extension");
  });

  it("names the language of a file", () => {
    expect(broadLanguageOf("a/b.py")).toBe("python");
    expect(broadLanguageOf("index.html")).toBe("html");
    expect(broadLanguageOf("x.tsx")).toBe("tsx");
    expect(broadLanguageOf("package.json")).toBe("config");
    expect(broadLanguageOf("Dockerfile")).toBe("other");
  });
});

describe("broad file reading: streaming", () => {
  const entries = [
    { name: "r-abc/README.md", body: "# Shop\n" },
    { name: "r-abc/src/a.ts", body: "export const a = 1;\n" },
    { name: "r-abc/app/main.py", body: "def main():\n    pass\n" },
    { name: "r-abc/web/index.html", body: '<button id="go">Go</button>\n' },
    { name: "r-abc/data/rows.csv", body: "a,b\n1,2\n" },
    { name: "r-abc/LICENSE", body: "MIT\n" },
  ];

  it("delivers only JavaScript, TypeScript and Markdown by default", async () => {
    const { files } = await ingest(entries, false);
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts"]);
  });

  it("delivers every text file in broad mode, labelled with its language", async () => {
    const { files } = await ingest(entries, true);
    expect(files.map((f) => `${f.path}:${f.language}`).sort()).toEqual(["README.md:markdown", "app/main.py:python", "src/a.ts:typescript", "web/index.html:html"]);
  });

  it("drops a binary file that has a text-looking name", async () => {
    const { files, stats } = await ingest([{ name: "r-abc/odd.py", body: "print(1)\u0000\u0000binary" }], true);
    expect(files).toHaveLength(0);
    expect(stats.skipped["binary-content"]).toBe(1);
  });

  it("bounds the other languages: a large file is skipped, code is not", async () => {
    const big = "x = 1\n".repeat(Math.ceil((BROAD_MAX_FILE_BYTES + 10) / 6));
    const { files, stats } = await ingest(
      [
        { name: "r-abc/big.py", body: big },
        { name: "r-abc/ok.py", body: "x = 1\n" },
        { name: "r-abc/code.ts", body: "export const a = 1;\n".repeat(20_000) },
      ],
      true,
    );
    expect(files.map((f) => f.path).sort()).toEqual(["code.ts", "ok.py"]);
    expect(stats.skipped["too-large"]).toBe(1);
  });

  it("stops reading other-language files after a fixed number, but keeps reading code", async () => {
    const many = Array.from({ length: BROAD_MAX_FILES + 5 }, (_, i) => ({ name: `r-abc/gen/f${i}.py`, body: `x = ${i}\n` }));
    const { files, stats } = await ingest([...many, { name: "r-abc/zzz/late.ts", body: "export const late = 1;\n" }], true);
    expect(files.filter((f) => f.language === "python")).toHaveLength(BROAD_MAX_FILES);
    expect(files.some((f) => f.path === "zzz/late.ts")).toBe(true);
    expect(stats.skipped["too-large"]).toBe(5);
  });
});
