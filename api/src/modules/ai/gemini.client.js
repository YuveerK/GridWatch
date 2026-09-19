import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/** parts: [{text}] | [{inlineData:{mimeType,data}}]; returns { text, inputTokens, outputTokens } */
export async function generateJson({ systemInstruction, parts, jsonSchema, hasImages, signal }) {
  // replays and evaluations run with this set: they may use stored readings and cached verdicts, but never spend on the provider
  if (process.env.GRIDWATCH_NO_AI === '1') throw new Error('AI calls are disabled (GRIDWATCH_NO_AI=1)');
  // every call has a deadline (AI_TIMEOUT_MS) and stops early when the caller's signal aborts (lease lost, shutdown)
  const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(env.AI_TIMEOUT_MS)]) : AbortSignal.timeout(env.AI_TIMEOUT_MS);
  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction,
      abortSignal,
      temperature: 0,
      maxOutputTokens: 6000,
      ...(env.GEMINI_THINKING === 'minimal' ? { thinkingConfig: { thinkingLevel: 'MINIMAL' } } : {}),
      responseMimeType: 'application/json',
      responseJsonSchema: jsonSchema,
      ...(hasImages ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}),
    },
  });
  return {
    text: response.text,
    inputTokens: response.usageMetadata?.promptTokenCount ?? null,
    // thinking tokens are billed as output
    outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}
