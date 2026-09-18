import { GoogleGenAI } from "@google/genai";
import { AppError } from "../../lib/errors.js";
import { extractionSchemaJson } from "./extraction.schema.js";

export function createGeminiClient({ apiKey, model, timeoutMs = 60_000, client = null }) {
  const ai = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
  return {
    async extract(prompt) {
      if (!ai) throw new AppError(503, "GEMINI_NOT_CONFIGURED", "GEMINI_API_KEY is not configured");
      const operation = ai.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", responseSchema: extractionSchemaJson } });
      const response = await Promise.race([operation, new Promise((_, reject) => setTimeout(() => reject(new AppError(504, "GEMINI_TIMEOUT", "Gemini request timed out")), timeoutMs))]);
      return { text: response.text, raw: response };
    },
  };
}
