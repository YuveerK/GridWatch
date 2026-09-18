import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/** parts: [{text}] | [{inlineData:{mimeType,data}}]; returns { text, inputTokens, outputTokens } */
export async function generateJson({ systemInstruction, parts, jsonSchema, hasImages }) {
  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction,
      temperature: 0,
      maxOutputTokens: 6000,
      responseMimeType: 'application/json',
      responseJsonSchema: jsonSchema,
      ...(hasImages ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}),
    },
  });
  return {
    text: response.text,
    inputTokens: response.usageMetadata?.promptTokenCount ?? null,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
  };
}
