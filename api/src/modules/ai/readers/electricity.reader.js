import { buildSystemPrompt, buildUserText } from '../prompt.js';
import { extractionJsonSchema, extractionSchema } from '../extraction.schema.js';

export const electricityReader = {
  serviceType: 'ELECTRICITY',
  promptVersion: null,
  buildSystemPrompt,
  buildUserText,
  jsonSchema: extractionJsonSchema,
  zodSchema: extractionSchema,
  normaliseReading: (reading) => reading,
};
