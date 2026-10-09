import { describe, expect, it } from "vitest";
import { countLines, lineWindows } from "../parse/chunk";
import { parseSource } from "../parse/extract";
import { IndexBuilder, parseJsonc, resolveImport } from "./build";
import { BASELINE_CONFIG, ENTRY_KIND_CODES, type IndexConfig } from "./types";

const KEY = { owner: "acme", repo: "mono", sha: "b".repeat(40) };
const FULL: IndexConfig = { ...BASELINE_CONFIG, includeConfig: true, resolveWorkspaceAndAliases: true };

async function build(files: Record<string, string>, config: IndexConfig, skipped: string[] = []) {
  const b = new IndexBuilder(KEY, config);
  for (const s of skipped) b.noteSkipped(s);
  for (const [p, text] of Object.entries(files)) {
    if (p.endsWith(".json")) {
      const lineCount = countLines(text);
      b.addFile({ path: p, language: "config", status: "text", failureReason: null, lineCount, symbols: [], imports: [], exports: [], chunks: lineWindows(lineCount), parseMs: 0 }, text, text.length);
    } else {
      b.addFile(await parseSource(p, p.endsWith(".tsx") ? "tsx" : p.endsWith(".ts") ? "typescript" : "javascript", text), text, text.length);
    }
  }
  const artifact = b.finish();
  return { artifact, b };
}

const idx = (a: Awaited<ReturnType<typeof build>>["artifact"], p: string) => a.files.findIndex((f) => f[0] === p);
const importOf = (a: Awaited<ReturnType<typeof build>>["artifact"], from: string, spec: string) => a.imports.find((i) => i[0] === idx(a, from) && i[1] === spec);

describe("parseJsonc", () => {
  it("accepts comments and trailing commas but leaves strings alone", () => {
    expect(parseJsonc('{ // c\n "a": "x // not a comment", /* b */ "b": [1, 2,], }')).toEqual({ a: "x // not a comment", b: [1, 2] });
  });
});

describe("resolveImport", () => {
  it("only tries declaration files when asked to", () => {
    const files = new Set(["types/a.d.ts"]);
    expect(resolveImport("fastify.d.ts", "./types/a", files)).toBeNull();
    expect(resolveImport("fastify.d.ts", "./types/a", files, { declarations: true })).toBe("types/a.d.ts");
  });
});

describe("package entry points", () => {
  it("maps a built main back to source and records the package", async () => {
    const { artifact, b } = await build(
      {
        "packages/lib/package.json": JSON.stringify({ name: "lib", main: "./dist/index.js", bin: { lib: "./bin/cli.js" } }),
        "packages/lib/src/index.ts": "export const a = 1;\n",
        "packages/lib/bin/cli.js": "console.log(1);\n",
      },
      FULL,
    );
    const entries = artifact.entries.map((e) => [artifact.files[e[0]]![0], ENTRY_KIND_CODES[e[1]], e[2]]);
    expect(entries).toEqual(expect.arrayContaining([["packages/lib/src/index.ts", "main", "lib"], ["packages/lib/bin/cli.js", "bin", "lib"]]));
    expect(b.entryStats()).toMatchObject({ declared: 2, resolved: 2 });
  });

  it("falls back to index.js when a package declares no entry", async () => {
    const { artifact } = await build({ "package.json": JSON.stringify({ name: "x" }), "index.js": "module.exports = 1;\n" }, FULL);
    expect(artifact.entries.map((e) => artifact.files[e[0]]![0])).toEqual(["index.js"]);
  });

  it("reports declared entries that point at output missing from the repository", async () => {
    const { b } = await build({ "package.json": JSON.stringify({ name: "x", main: "dist/missing.js" }) }, FULL);
    expect(b.entryStats().unresolved).toHaveLength(1);
  });
});

describe("import resolution", () => {
  const files = {
    "package.json": JSON.stringify({ name: "root", main: "lib/main.js" }),
    "lib/main.js": "module.exports = {};\n",
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
    "packages/ui/src/index.ts": "export const ui = 1;\n",
    "packages/ui/src/button.ts": "export const button = 1;\n",
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
    "src/util.ts": "export const u = 1;\n",
    "src/app.ts": 'import { u } from "@/util";\nimport { ui } from "@acme/ui";\nimport { button } from "@acme/ui/src/button";\nimport x from "src/util";\nimport "./style.css";\nimport "./gone";\nimport "./ignored";\nimport fs from "node:fs";\nimport react from "react";\nimport main from "..";\n',
  };

  it("leaves aliases, workspace packages and baseUrl imports unresolved when the feature is off", async () => {
    const { artifact } = await build(files, { ...BASELINE_CONFIG, includeConfig: true });
    expect(importOf(artifact, "src/app.ts", "@/util")?.[3]).toBeLessThan(0);
    expect(importOf(artifact, "src/app.ts", "@acme/ui")?.[3]).toBeLessThan(0);
  });

  it("resolves tsconfig paths, baseUrl, workspace packages and directory imports", async () => {
    const { artifact, b } = await build(files, FULL, ["src/ignored.ts"]);
    const target = (spec: string) => artifact.files[importOf(artifact, "src/app.ts", spec)![3]]?.[0];
    expect(target("@/util")).toBe("src/util.ts");
    expect(target("@acme/ui")).toBe("packages/ui/src/index.ts");
    expect(target("@acme/ui/src/button")).toBe("packages/ui/src/button.ts");
    expect(target("src/util")).toBe("src/util.ts");
    expect(target("..")).toBe("lib/main.js");
    const c = b.importStats().categories;
    expect(c["relative:unresolved-asset"]).toBe(1);
    expect(c["relative:unresolved-missing"]).toBe(1);
    expect(c["relative:unresolved-excluded-file"]).toBe(1);
    expect(c["bare:node-builtin"]).toBe(1);
    expect(c["bare:external-package"]).toBe(1);
  });

  it("keeps source text out of the artifact even with configuration indexed", async () => {
    const { artifact } = await build({ "package.json": JSON.stringify({ name: "x", description: "SENTINEL PHRASE WITH SPACES" }) }, FULL);
    expect(JSON.stringify(artifact)).not.toContain("SENTINEL PHRASE WITH SPACES");
  });
});
