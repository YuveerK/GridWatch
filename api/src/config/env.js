import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.1-flash-lite'),
  AI_PROMPT_VERSION: z.string().default('outage-extraction.v1'),
  X_API_BEARER_TOKEN: z.string().optional(),
  X_SOURCE_ACCOUNT_ID: z.string().default('337882328'),
  X_SOURCE_ACCOUNT_NAME: z.string().default('CityPowerJhb'),
  X_POLL_INTERVAL_MINUTES: z.coerce.number().default(5),
  GEMINI_THINKING: z.enum(['default', 'minimal']).default('default'),
  KNOWLEDGE_CONTEXT: z.enum(['on', 'off']).default('on'),
  PROCESSING_CONCURRENCY: z.coerce.number().default(3),
  MEDIA_MAX_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  LINK_HIGH_SCORE: z.coerce.number().default(0.7),
  LINK_LOW_SCORE: z.coerce.number().default(0.35),
  OUTAGE_WINDOW_HOURS: z.coerce.number().default(72),
  OUTAGE_AUTOCLOSE_HOURS: z.coerce.number().default(48),
});

export const env = schema.parse(process.env);
