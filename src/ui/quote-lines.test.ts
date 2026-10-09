import { describe, expect, it } from "vitest";
import { quotedLines } from "./quote-lines";

const LINES = ["export function alpha() {", "\tconst x = 1;", "", "\treturn x + 1;", "}", "export const beta = alpha();"];

describe("quotedLines", () => {
  it("finds a one-line quote, whatever its indentation, and reports file line numbers", () => {
    expect(quotedLines(LINES, 40, "const x = 1;")).toEqual({ from: 41, to: 41 });
    expect(quotedLines(LINES, 1, "return   x + 1;")).toEqual({ from: 4, to: 4 });
  });

  it("finds part of a line", () => {
    expect(quotedLines(LINES, 10, "beta = alpha()")).toEqual({ from: 15, to: 15 });
  });

  it("finds a passage that runs over several lines, including a blank one", () => {
    expect(quotedLines(LINES, 1, "const x = 1;\n\nreturn x + 1;\n}")).toEqual({ from: 2, to: 5 });
    expect(quotedLines(LINES, 1, "L1| export function alpha() {\nL2| const x = 1;")).toEqual({ from: 1, to: 2 });
  });

  it("points at the first occurrence when the text appears twice", () => {
    expect(quotedLines(["a = 1;", "b = 2;", "a = 1;"], 1, "a = 1;")).toEqual({ from: 1, to: 1 });
  });

  it("returns nothing for text that is not there, that skips a line, or that is too short to place", () => {
    expect(quotedLines(LINES, 1, "const y = 2;")).toBeNull();
    expect(quotedLines(LINES, 1, "export function alpha() {\nreturn x + 1;")).toBeNull();
    expect(quotedLines(LINES, 1, "}")).toBeNull();
    expect(quotedLines([], 1, "anything")).toBeNull();
  });
});
