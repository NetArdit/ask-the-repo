import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("production start commands", () => {
  it("run the server with --liftoff-only, which keeps WASM parsing within the free-instance memory budget", () => {
    expect((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts.start).toContain("--liftoff-only");
    expect(read("Dockerfile")).toMatch(/CMD \["node", "--liftoff-only", "server\.js"\]/);
  });

  it("never commit secrets in the deployment blueprint", () => {
    const yaml = read("render.yaml");
    for (const key of ["GROQ_API_KEY", "GITHUB_TOKEN"]) expect(yaml).toMatch(new RegExp(String.raw`key: ${key}\r?\n\s+sync: false`));
    expect(yaml).not.toMatch(/gsk_|ghp_|github_pat_/);
  });
});
