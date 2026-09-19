import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/x', GEMINI_API_KEY: 'k' };
const bad = (over) => {
  try {
    parseEnv({ ...base, ...over });
    return null;
  } catch (err) {
    return String(err.message);
  }
};

describe('configuration is validated at start-up (A16)', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const e = parseEnv(base);
    expect(e.PORT).toBe(4000);
    expect(e.X_POLL_INTERVAL_MINUTES).toBe(5);
    expect(e.LINK_LOW_SCORE).toBeLessThanOrEqual(e.LINK_HIGH_SCORE);
  });
  it('rejects fractions, negatives and out-of-range budgets instead of coercing them', () => {
    expect(bad({ REFRESH_MAX_POSTS: '-1' })).toBeTruthy();
    expect(bad({ REFRESH_MAX_POSTS: '1.5' })).toBeTruthy();
    expect(bad({ REFRESH_MAX_POSTS: 'abc' })).toBeTruthy();
    expect(bad({ PORT: '70000' })).toBeTruthy();
    expect(bad({ X_POLL_INTERVAL_MINUTES: '0' })).toBeTruthy();
    expect(bad({ X_MAX_PAGES_PER_RUN: '0' })).toBeTruthy();
    expect(bad({ MEDIA_MAX_BYTES: '10' })).toBeTruthy();
  });
  it('a zero processing budget is a real, valid value (it means none, not unlimited)', () => {
    expect(parseEnv({ ...base, REFRESH_MAX_POSTS: '0' }).REFRESH_MAX_POSTS).toBe(0);
  });
  it('link thresholds must be in [0,1] and ordered', () => {
    expect(bad({ LINK_HIGH_SCORE: '1.5' })).toBeTruthy();
    expect(bad({ LINK_LOW_SCORE: '0.9', LINK_HIGH_SCORE: '0.5' })).toBeTruthy();
    expect(parseEnv({ ...base, LINK_LOW_SCORE: '0.2', LINK_HIGH_SCORE: '0.8' }).LINK_LOW_SCORE).toBe(0.2);
  });
  it('operator settings: short tokens and malformed origins are refused; the old name still works', () => {
    expect(bad({ OPERATOR_TOKEN: 'short' })).toBeTruthy();
    expect(bad({ CORS_ALLOWED_ORIGINS: 'not a url' })).toBeTruthy();
    expect(parseEnv({ ...base, REFRESH_TOKEN: 'a-long-enough-token-123' }).OPERATOR_TOKEN).toBe('a-long-enough-token-123');
    expect(parseEnv({ ...base, CORS_ALLOWED_ORIGINS: 'https://ops.example.com, http://localhost:5173' }).CORS_ALLOWED_ORIGINS).toEqual(['https://ops.example.com', 'http://localhost:5173']);
  });
});
