import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/** parts: [{text}] | [{inlineData:{mimeType,data}}]; returns { text, inputTokens, outputTokens } */
// Evaluations and repairs can limit what may be paid for:
//   GRIDWATCH_NO_AI=1                nothing
//   GRIDWATCH_AI_ONLY=tiebreak       only the small "same fault or not?" question (never a post reading)
//   GRIDWATCH_AI_MAX_CALLS=<n>       and never more than n calls in this process
// Every call is counted, so a run can say exactly what it cost.
export const aiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

export async function generateJson({ systemInstruction, parts, jsonSchema, hasImages, signal, purpose = 'extraction' }) {
  if (process.env.GRIDWATCH_NO_AI === '1') throw new Error('AI calls are disabled (GRIDWATCH_NO_AI=1)');
  if (process.env.GRIDWATCH_AI_ONLY && process.env.GRIDWATCH_AI_ONLY !== purpose) throw new Error(`AI calls for ${purpose} are not allowed in this run (GRIDWATCH_AI_ONLY=${process.env.GRIDWATCH_AI_ONLY})`);
  if (process.env.GRIDWATCH_AI_MAX_CALLS && aiUsage.calls >= Number(process.env.GRIDWATCH_AI_MAX_CALLS)) throw new Error('AI call limit reached for this run');
  aiUsage.calls += 1;
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
  aiUsage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
  aiUsage.outputTokens += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);
  return {
    text: response.text,
    inputTokens: response.usageMetadata?.promptTokenCount ?? null,
    // thinking tokens are billed as output
    outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}
