import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_DECODED_INDEX_BYTES, deserializeIndex } from "./serialize";

describe("decoding a stored index", () => {
  it("refuses a payload that expands past the limit instead of allocating it", () => {
    const bomb = brotliCompressSync(Buffer.alloc(2 * 1024 * 1024, 97));
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => deserializeIndex(bomb, 1024 * 1024)).toThrow();
  });

  it("keeps a limit far above the largest real index (about 9 MB)", () => {
    expect(MAX_DECODED_INDEX_BYTES).toBeGreaterThanOrEqual(100 * 1024 * 1024);
  });
});
