import { describe, expect, it } from "vitest";
import { stem } from "./tokenize";

describe("stem", () => {
  it("folds plurals in both modes", () => {
    expect(stem("hooks")).toBe("hook");
    expect(stem("queries")).toBe("query");
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
  });

  it("leaves verb forms alone in plural mode", () => {
    expect(stem("listening")).toBe("listening");
  });

  it("folds -ing/-ed in plural+verb mode without mangling short words", () => {
    expect(stem("listening", "plural+verb")).toBe("listen");
    expect(stem("mounted", "plural+verb")).toBe("mount");
    expect(stem("running", "plural+verb")).toBe("run");
    expect(stem("string", "plural+verb")).toBe("string");
    expect(stem("red", "plural+verb")).toBe("red");
  });
});
