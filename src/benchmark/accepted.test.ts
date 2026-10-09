import { describe, expect, it } from "vitest";
import { DEFAULT_INDEX_CONFIG, DEFAULT_SEARCH_OPTIONS } from "../retrieve/defaults";
import { resolveSpec } from "./experiments";

describe("accepted experiment configuration", () => {
  it("matches the production retrieval defaults", () => {
    const accepted = resolveSpec("accepted");
    expect(accepted.index).toEqual(DEFAULT_INDEX_CONFIG);
    expect(accepted.search).toEqual(DEFAULT_SEARCH_OPTIONS);
  });
});
