import { describe, expect, it } from "vitest";
import { normalizeLabel } from "../../src/modules/geography/normalization.js";

describe("normalizeLabel", () => {
  it("normalizes whitespace, punctuation, accents, and extension variants", () => {
    expect(normalizeLabel("  Willowbrook EXT.  ")).toBe("willowbrook extension");
    expect(normalizeLabel("Morningside–South")).toBe("morningside south");
  });
});
