import { describe, expect, it } from "vitest";
import { classifyFile, questionWantsNonSource } from "./file-class";

describe("classifyFile", () => {
  it.each([
    ["src/app.ts", "source"],
    ["lib/router/index.js", "source"],
    ["src/helper/testing/index.ts", "source"],
    ["test/app.listen.js", "test"],
    ["packages/x/__tests__/a.ts", "test"],
    ["src/foo.test.ts", "test"],
    ["src/foo.spec.tsx", "test"],
    ["packages/zod/src/v4/core/tests/a.ts", "test"],
    ["router_test.go", "test"],
    ["pkg/api/handler_spec.rb", "test"],
    ["src/test_signer.py", "test"],
    ["tests/test_signer.py", "test"],
    ["app/src/UserTest.java", "test"],
    ["app/src/UserTests.kt", "test"],
    ["Sources/FooTests.swift", "test"],
    ["src/Bar/BarTest.cs", "test"],
    ["pkg/testdata/sample.go", "test"],
    [".github/workflows/runtime_build_and_test.yml", "source"],
    ["router.go", "source"],
    ["src/signer.py", "source"],
    ["src/contest.js", "source"],
    ["src/latest.ts", "source"],
    ["pkg/protest.go", "source"],
    ["examples/auth/index.js", "example"],
    ["packages/create-vite/template-react/src/App.tsx", "example"],
    ["docs/guide/a.md", "docs"],
    ["README.md", "docs"],
  ] as const)("%s -> %s", (p, cls) => {
    expect(classifyFile(p, false)).toBe(cls);
  });

  it("marks configuration files", () => {
    expect(classifyFile("package.json", true)).toBe("config");
  });
});

describe("questionWantsNonSource", () => {
  it("skips demotion when the question asks for tests, examples or docs", () => {
    expect(questionWantsNonSource("Where is the example of auth?")).toBe(true);
    expect(questionWantsNonSource("Which tests cover retries?")).toBe(true);
    expect(questionWantsNonSource("Where is retry implemented?")).toBe(false);
  });
});
