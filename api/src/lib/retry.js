// Temporary failures (the AI provider is busy or unreachable) are worth trying again; anything else (a guard that forbids the call, an
// answer that does not parse, a real refusal) will not change by asking again and must be left for a person.

const TRANSIENT = /\b(429|500|502|503|504)\b|rate.?limit|too many requests|overload|unavailable|temporar|timed? ?out|timeout|deadline|aborted|fetch failed|network|socket|ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/i;
const NEVER = /not allowed in this run|call limit reached|AI calls are disabled|invalid api key|permission|unauthori[sz]ed|\b(400|401|403)\b/i;

export function isTransientAiError(err) {
  const m = String(err?.message ?? err ?? '');
  return !NEVER.test(m) && TRANSIENT.test(m);
}

/** Run `fn`, retrying transient failures after each delay in `delaysMs` (so delaysMs.length + 1 tries in all). Rethrows the last error. */
export async function retryTransient(fn, { delaysMs = [1000, 3000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fn(i);
    } catch (err) {
      last = err;
      if (!isTransientAiError(err) || i === delaysMs.length) break;
      await sleep(delaysMs[i]);
    }
  }
  throw last;
}

/**
 * The schedule of automatic RETRIES of a failed tie-break (not counting the failure itself, nor the quick in-call re-asks of retryTransient,
 * which are separate: 3 asks in one go). The first retry is due 5 minutes after the failure, then 15, 45, 120 and 360 minutes after each
 * failed retry: five retries in all, then it is left for a person.
 *   `retriesDone` = how many automatic retries have already been made (0 when the failure has just been queued).
 */
export const RETRY_BACKOFF_MINUTES = [5, 15, 45, 120, 360];
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MINUTES.length;
export const nextRetryAt = (retriesDone, now = new Date()) => (retriesDone >= MAX_RETRY_ATTEMPTS ? GAVE_UP_AT : new Date(now.getTime() + RETRY_BACKOFF_MINUTES[Math.max(0, retriesDone)] * 60_000));
export const GAVE_UP_AT = new Date('9999-01-01T00:00:00Z'); // an exhausted retry: no automatic try is ever due again
