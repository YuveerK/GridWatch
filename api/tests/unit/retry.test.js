import { describe, expect, it } from 'vitest';
import { RETRY_BACKOFF_MINUTES, isTransientAiError, nextRetryAt, retryTransient } from '../../src/lib/retry.js';

describe('which AI failures are temporary', () => {
  it.each(['503 Service Unavailable', 'The model is overloaded. Please try again later.', 'fetch failed', 'Request timed out', '429 Too Many Requests', 'ECONNRESET', 'The operation was aborted due to timeout'])('%s is', (m) => expect(isTransientAiError(new Error(m))).toBe(true));
  it.each(['AI call limit reached for this run', 'AI calls for tiebreak are not allowed in this run (GRIDWATCH_AI_ONLY=extraction)', 'AI calls are disabled (GRIDWATCH_NO_AI=1)', 'API key not valid', '403 permission denied', 'Unexpected token } in JSON', 'candidate outage id not offered'])('%s is not', (m) => expect(isTransientAiError(new Error(m))).toBe(false));
});

describe('retrying a temporary failure', () => {
  const sleeps = () => { const w = []; const sleep = async (ms) => { w.push(ms); }; sleep.w = w; return sleep; };
  it('succeeds on a later try, waiting between tries', async () => {
    let calls = 0;
    const sleep = sleeps();
    const out = await retryTransient(async () => { calls += 1; if (calls < 3) throw new Error('503 unavailable'); return 'ok'; }, { delaysMs: [10, 30], sleep });
    expect(out).toBe('ok');
    expect(sleep.w).toEqual([10, 30]);
  });
  it('gives up after the last delay with the last error, and never retries a non-temporary failure', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls += 1; throw new Error('503 unavailable'); }, { delaysMs: [1, 1], sleep: sleeps() })).rejects.toThrow('503');
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryTransient(async () => { calls += 1; throw new Error('AI call limit reached for this run'); }, { delaysMs: [1, 1], sleep: sleeps() })).rejects.toThrow('limit');
    expect(calls).toBe(1);
  });
});

describe('the wait before the next automatic try', () => {
  it('grows: 5 min, 15 min, 45 min, 2 h, 6 h', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    expect(RETRY_BACKOFF_MINUTES).toEqual([5, 15, 45, 120, 360]);
    // nextRetryAt(retriesDone): 0 = the failure has just been queued
    expect([0, 1, 2, 3, 4].map((n) => (+nextRetryAt(n, now) - +now) / 60_000)).toEqual([5, 15, 45, 120, 360]);
    expect(nextRetryAt(5, now).getUTCFullYear()).toBe(9999); // after the fifth retry nothing is due again
  });
});
