import { describe, expect, it, vi } from "vitest";

vi.mock("./languages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./languages")>();
  return {
    ...actual,
    getParser: async (name: "javascript" | "typescript" | "tsx") => {
      throw new actual.GrammarLoadError(name, new Error("Cannot find module"));
    },
  };
});

describe("parseSource when a grammar cannot be loaded", () => {
  it("fails loudly instead of degrading every file to line windows", async () => {
    const { parseSource } = await import("./extract");
    const { GrammarLoadError } = await import("./languages");
    await expect(parseSource("a.ts", "typescript", "export const a = 1;\n")).rejects.toBeInstanceOf(GrammarLoadError);
  });

  it("still handles text files, which need no grammar", async () => {
    const { parseSource } = await import("./extract");
    expect((await parseSource("README.md", "markdown", "# hi\n")).status).toBe("text");
  });
});
