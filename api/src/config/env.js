import "dotenv/config";
import { z } from "zod";

const optionalString = z.string().trim().optional().default("");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  X_API_BEARER_TOKEN: optionalString,
  X_SOURCE_ACCOUNT_ID: optionalString,
  X_SOURCE_ACCOUNT_NAME: z.string().trim().default("CityPowerJhb"),
  X_POLL_INTERVAL_MINUTES: z.coerce.number().positive().default(10),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().trim().default("gemini-3.1-flash-lite"),
  AI_PROMPT_VERSION: z.string().trim().default("outage-extraction.v1"),
  AI_SCHEMA_VERSION: z.string().trim().default("1"),
  OCR_LANGUAGE: z.string().trim().default("eng"),
  PROCESSING_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  MEDIA_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  X_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  INCIDENT_ASSOCIATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  LOCALITY_FUZZY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  KNOWLEDGE_CONTEXT_MAX_ASSETS: z.coerce.number().int().positive().default(25),
  KNOWLEDGE_CONTEXT_MAX_RELATIONSHIPS: z.coerce.number().int().positive().default(50),
});

export function loadConfig(overrides = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return parsed.data;
}

export const config = loadConfig();
