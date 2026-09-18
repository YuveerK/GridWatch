import { describe, expect, it } from "vitest";
import { extractionSchema, extractionSchemaJson } from "../../src/modules/ai/extraction.schema.js";

describe("extractionSchema", () => {
  it("accepts a minimal evidence-safe extraction", () => {
    const value = extractionSchema.parse({ relevance: "IRRELEVANT" });
    expect(value.relevance).toBe("IRRELEVANT");
    expect(value.affectedAreas).toEqual([]);
  });

  it("rejects confidence outside the contract", () => {
    expect(() => extractionSchema.parse({ relevance: "OUTAGE", affectedAreas: [{ name: "Parkhurst", evidence: "TEXT", confidence: 2 }] })).toThrow();
  });

  it("defines every required property for Gemini structured output", () => {
    for (const property of extractionSchemaJson.required) expect(extractionSchemaJson.properties[property]).toBeDefined();
  });
});
