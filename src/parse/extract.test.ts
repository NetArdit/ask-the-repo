import { describe, expect, it } from "vitest";
import { countLines, lineWindows, mergeUnits } from "./chunk";
import { parseSource } from "./extract";

const names = (r: { symbols: { qualifiedName: string }[] }) => r.symbols.map((s) => s.qualifiedName);

describe("parseSource: TypeScript", () => {
  const src = `import React, { useState } from "react";
import * as fs from "node:fs";
import "./side";
export { a as b, c } from "./x";
export * from "./y";
export default function Page() { return 1 }
export const handler = async (req) => {};
export class Foo extends Bar { run() {} static make = () => 1; }
export interface I { x: number }
export type T = string;
const lazy = () => import("./lazy");
function helper() {}
export { helper };
`;

  it("extracts symbols, imports and exports with line numbers", async () => {
    const r = await parseSource("a.ts", "typescript", src);
    expect(r.status).toBe("ast");
    expect(names(r)).toEqual(["Page", "handler", "Foo", "Foo.run", "Foo.make", "I", "T", "lazy", "helper"]);
    expect(r.symbols.find((s) => s.name === "Page")).toMatchObject({ kind: "function", exported: true, startLine: 6 });
    expect(r.symbols.find((s) => s.name === "helper")?.exported).toBe(false);
    expect(r.imports.map((i) => `${i.kind}:${i.specifier}`)).toEqual([
      "esm:react", "esm:node:fs", "esm:./side", "reexport:./x", "reexport:./y", "dynamic:./lazy",
    ]);
    expect(r.imports[0]?.names).toEqual(["default", "useState"]);
    expect(r.exports.map((e) => e.name)).toEqual(expect.arrayContaining(["b", "c", "*", "default", "handler", "Foo", "I", "T", "helper"]));
  });

  it("parses TSX", async () => {
    const r = await parseSource("c.tsx", "tsx", "export function A() { return <div className=\"x\">{1}</div>; }\n");
    expect(r.status).toBe("ast");
    expect(names(r)).toEqual(["A"]);
  });
});

describe("parseSource: CommonJS", () => {
  it("extracts require calls and CommonJS exports", async () => {
    const r = await parseSource(
      "b.js",
      "javascript",
      `const { a, b: c } = require("./a");
const x = require("express");
exports.foo = function foo() {};
app.listen = function listen() {};
module.exports = { alpha, beta: 1 };
function createApp() {}
`,
    );
    expect(r.status).toBe("ast");
    expect(r.imports.map((i) => [i.specifier, i.names])).toEqual([["./a", ["a", "b"]], ["express", ["x"]]]);
    expect(names(r)).toEqual(expect.arrayContaining(["exports.foo", "app.listen", "createApp"]));
    expect(r.exports.map((e) => e.name)).toEqual(expect.arrayContaining(["foo", "default", "alpha", "beta"]));
  });
});

describe("parseSource: failure handling", () => {
  it("flags malformed source instead of claiming a clean parse", async () => {
    const r = await parseSource("bad.ts", "typescript", "function ( {{{ export class\n");
    expect(r.status).toBe("ast-with-errors");
    expect(r.chunks.length).toBeGreaterThan(0);
  });

  it("falls back to deterministic line windows when parsing is cancelled", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const r = await parseSource("big.ts", "typescript", big, { timeoutMs: 0 });
    expect(r.status).toBe("fallback");
    expect(r.failureReason).toBe("parse-timeout");
    expect(r.symbols).toEqual([]);
    expect(r.chunks).toEqual(lineWindows(4000));
  });

  it("falls back for files with no grammar", async () => {
    const r = await parseSource("weird.xyz", "javascript", "a\nb\n");
    expect(r.status).toBe("fallback");
    expect(r.failureReason).toBe("no-grammar");
  });

  it("treats markdown as text with line windows", async () => {
    const r = await parseSource("README.md", "markdown", "# t\n".repeat(120));
    expect(r.status).toBe("text");
    expect(r.chunks).toHaveLength(3);
  });

  it("does not execute or interpret hostile source", async () => {
    const r = await parseSource("evil.js", "javascript", "process.exit(1); require('child_process').execSync('echo pwned');\n");
    expect(r.imports.map((i) => i.specifier)).toEqual(["child_process"]);
  });
});

describe("chunking", () => {
  it("covers every line exactly once, in order", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`export function f${i}() {`, ...Array.from({ length: 12 }, (_, j) => `  const x${j} = ${j};`), "}", "");
    const text = lines.join("\n");
    const r = await parseSource("many.ts", "typescript", text);
    const total = countLines(text);
    expect(r.chunks[0]?.startLine).toBe(1);
    expect(r.chunks.at(-1)?.endLine).toBe(total);
    for (let i = 1; i < r.chunks.length; i++) expect(r.chunks[i]!.startLine).toBe(r.chunks[i - 1]!.endLine + 1);
    for (const c of r.chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(80);
  });

  it("splits oversized classes by member and oversized functions by window", async () => {
    const methods = Array.from({ length: 12 }, (_, i) => `  m${i}() {\n${"    const a = 1;\n".repeat(10)}  }`).join("\n");
    const r = await parseSource("cls.ts", "typescript", `export class Big {\n${methods}\n}\n`);
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(80);
    const huge = await parseSource("fn.ts", "typescript", `function huge() {\n${"  const a = 1;\n".repeat(300)}}\n`);
    for (const c of huge.chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(80);
  });

  it("mergeUnits handles empty input", () => {
    expect(mergeUnits([], 0)).toEqual([]);
    expect(mergeUnits([], 10)).toEqual(lineWindows(10));
  });
});

describe("Flow-typed JavaScript", () => {
  const flow = `// @flow
import type {Fiber} from './Fiber';
export type Props = {|a: number|};
export function begin(fiber: Fiber, n: ?number): void {
  const x = (n: any);
}
`;

  it("is parsed with errors by the JavaScript grammar", async () => {
    const r = await parseSource("flow.js", "javascript", flow);
    expect(r.status).toBe("ast-with-errors");
  });

  it("is recovered by the TSX fallback variant when it yields a cleaner tree", async () => {
    const plain = await parseSource("flow.js", "javascript", flow);
    const fallback = await parseSource("flow.js", "javascript", flow, { variant: "flow-tsx-fallback" });
    expect(fallback.symbols.map((s) => s.name)).toContain("begin");
    expect(fallback.symbols.length).toBeGreaterThanOrEqual(plain.symbols.length);
  });

  it("does not change files that already parse cleanly", async () => {
    const src = "export function a() { return 1; }\n";
    const plain = await parseSource("a.js", "javascript", src);
    const fallback = await parseSource("a.js", "javascript", src, { variant: "flow-tsx-fallback" });
    expect(fallback).toEqual({ ...plain, parseMs: fallback.parseMs });
  });
});
