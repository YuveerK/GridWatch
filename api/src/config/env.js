import 'dotenv/config';
import { z } from 'zod';

// Every setting is validated at start-up, so a typo fails loudly instead of quietly defeating a limit
// (for example a spend cap of 0 that used to mean "no cap"). Empty values count as "not set".

const int = (min, max) => z.coerce.number().int().min(min).max(max);
const flag = z.enum(['on', 'off']);

const origins = z
  .string()
  .default('')
  .transform((v, ctx) => {
    const list = v.split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const item of list) {
      try {
        const u = new URL(item);
        if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
        out.push(u.origin);
      } catch {
        ctx.addIssue({ code: 'custom', message: `"${item}" is not an origin like http://localhost:5173` });
        return z.NEVER;
      }
    }
    return out;
  });

export const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: int(1, 65535).default(4000),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    AI_PROMPT_VERSION: z.string().min(1).default('outage-extraction.v1'),
    AI_TIMEOUT_MS: int(1000, 600_000).default(90_000),
    X_API_BEARER_TOKEN: z.string().optional(),
    X_SOURCE_ACCOUNT_ID: z.string().regex(/^\d+$/, 'must be a numeric X user id').default('337882328'),
    X_SOURCE_ACCOUNT_NAME: z.string().min(1).default('CityPowerJhb'),
    // Replies are City Power answering individual customers ("@user Hi, we have no ETR"): never useful, and each costs $0.005.
    X_INCLUDE_REPLIES: flag.default('off'),
    // Pages of posts (up to 100 each, billed per post) one fetch may pull. An interrupted or capped fetch resumes next time.
    X_MAX_PAGES_PER_RUN: int(1, 100).default(20),
    // How often the scheduler runs, in minutes (elapsed time between runs, so any value from 1 minute to a day is exact).
    X_POLL_INTERVAL_MINUTES: int(1, 1440).default(5),
    GEMINI_THINKING: z.enum(['default', 'minimal']).default('default'),
    KNOWLEDGE_CONTEXT: flag.default('on'),
    // The manual "fetch latest posts" button (an operator tool until the scheduler is switched on)
    REFRESH_BUTTON: flag.default('on'),
    REFRESH_COOLDOWN_SECONDS: int(0, 86_400).default(60),
    // Posts READ (sent to the AI) per refresh. 0 is allowed and means exactly that: fetch and store posts, read none.
    REFRESH_MAX_POSTS: int(0, 5000).default(200),
    // Who may run paid or destructive operations (admin routes, the refresh button). See docs in README.
    OPERATOR_TOKEN: z.string().min(16, 'use at least 16 characters').optional(),
    REFRESH_TOKEN: z.string().min(16).optional(), // deprecated name for OPERATOR_TOKEN
    OPERATOR_SESSION_HOURS: int(1, 168).default(12),
    ALLOW_LOCAL_OPERATOR: flag.default('off'), // explicit local-development escape hatch; ignored in production
    // Push notifications to phones (Expo). PUSH_DRY_RUN=on logs what would be sent instead of sending it.
    PUSH_ENABLED: flag.default('on'),
    PUSH_DRY_RUN: flag.default('off'),
    EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
    CORS_ALLOWED_ORIGINS: origins,
    MEDIA_MAX_BYTES: int(1024, 50 * 1024 * 1024).default(10 * 1024 * 1024),
    LINK_HIGH_SCORE: z.coerce.number().min(0).max(1).default(0.7),
    LINK_LOW_SCORE: z.coerce.number().min(0).max(1).default(0.35),
    // A STALE unplanned outage (no news for a while, outcome unknown) can still be picked up again by a post naming its exact equipment,
    // up to this many hours after its last news. Only the tie-break may do it, never an automatic link.
    STALE_REVIVAL_HOURS: int(1, 24 * 60).default(240),
    OUTAGE_WINDOW_HOURS: int(1, 24 * 30).default(72),
    OUTAGE_AUTOCLOSE_HOURS: int(1, 24 * 30).default(48),
  })
  .refine((e) => e.LINK_LOW_SCORE <= e.LINK_HIGH_SCORE, { message: 'LINK_LOW_SCORE must not exceed LINK_HIGH_SCORE', path: ['LINK_LOW_SCORE'] })
  .transform((e) => ({ ...e, OPERATOR_TOKEN: e.OPERATOR_TOKEN ?? e.REFRESH_TOKEN }));

/** Validate a set of variables (used at start-up, and by tests with made-up values). */
export function parseEnv(source) {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== '' && v !== undefined));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`).join('\n');
    const err = new Error(`Invalid configuration:\n${problems}`);
    err.issues = result.error.issues;
    throw err;
  }
  return result.data;
}

export const env = parseEnv(process.env);
