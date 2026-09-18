import { extractionSchema } from "./extraction.schema.js";
import { buildPrompt, promptVersion } from "./prompts/outage-extraction.v1.js";

export function createExtractionService({ geminiClient, schemaVersion = "1" }) {
  return {
    async extract({ post, ocr = [], localityCandidates = [], infrastructureCandidates = [], incidentCandidates = [], knowledgeContext = [] }) {
      const prompt = buildPrompt({ post, ocr, localityCandidates, infrastructureCandidates, incidentCandidates, knowledgeContext });
      const response = await geminiClient.extract(prompt);
      const parsed = extractionSchema.parse(JSON.parse(response.text));
      return { parsed, rawModelOutput: response.raw, promptVersion, schemaVersion };
    },
  };
}
