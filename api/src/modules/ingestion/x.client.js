import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const BASE = 'https://api.x.com/2';

export class XRateLimitError extends Error {
  constructor(resetAt) {
    super('X API rate limited');
    this.resetAt = resetAt;
  }
}

/** X rejected the saved pagination token (expired or no longer valid): the interval must be re-fetched from its start. */
export class XInvalidTokenError extends Error {
  constructor(detail) {
    super(`X rejected the saved pagination token: ${detail}`);
  }
}

/** The request never reached X (internet or DNS trouble, or a timeout). Nothing was sent, so nothing was charged. */
export class XNetworkError extends Error {
  constructor(reason) {
    super("Couldn't reach X. Check your internet connection and try again.");
    this.reason = reason;
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when the failure happened before any answer came back (as opposed to X answering with an error). */
export const isNetworkFailure = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError' || NETWORK_CODES.has(err?.cause?.code) || (err instanceof TypeError && /fetch failed/i.test(err.message));

/**
 * One request, retried once after a short pause if it never reached X.
 * Only that case is retried: an answer from X (rate limit, bad key, no credit, server error) is final,
 * and a request that never arrived cannot have been billed.
 */
async function requestWithRetry(url, init, { retryDelayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      const reason = err.cause?.code ?? err.cause?.message ?? err.name ?? err.message;
      if (attempt >= 2) {
        logger.error({ reason }, 'could not reach X after a retry');
        throw new XNetworkError(reason);
      }
      logger.warn({ reason }, 'could not reach X; trying once more');
      await sleep(retryDelayMs);
    }
  }
}

const TWEET_FIELDS = 'created_at,lang,public_metrics,conversation_id,note_tweet,attachments,referenced_tweets,entities';

/**
 * Fetch one page of an account's posts newer than `sinceId` (newest first).
 * Returns { posts: [{ tweet, media: [] }], nextToken }.
 */
export async function fetchTimelinePage({ userId, sinceId, paginationToken, startTime, endTime }, { retryDelayMs } = {}) {
  if (!env.X_API_BEARER_TOKEN) throw new Error('X_API_BEARER_TOKEN is not set');
  const params = new URLSearchParams({
    max_results: '100',
    // Pay per post returned, so don't fetch what we'd discard: replies are customer-service answers, not outage news.
    exclude: env.X_INCLUDE_REPLIES === 'on' ? 'retweets' : 'retweets,replies',
    'tweet.fields': TWEET_FIELDS,
    expansions: 'attachments.media_keys',
    'media.fields': 'media_key,type,url,width,height,duration_ms,preview_image_url',
  });
  if (sinceId) params.set('since_id', sinceId);
  if (paginationToken) params.set('pagination_token', paginationToken);
  // User timelines are newest-first. start_time/end_time bound a historical backfill when the API honours them.
  if (startTime) params.set('start_time', new Date(startTime).toISOString());
  if (endTime) params.set('end_time', new Date(endTime).toISOString());

  const res = await requestWithRetry(`${BASE}/users/${userId}/tweets?${params}`, { headers: { Authorization: `Bearer ${env.X_API_BEARER_TOKEN}` } }, { retryDelayMs });
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    throw new XRateLimitError(reset ? new Date(reset * 1000) : null);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 400 && paginationToken && /pagination|token|next_token/i.test(detail)) throw new XInvalidTokenError(detail);
    throw new Error(`X API ${res.status}: ${detail}`);
  }

  const body = await res.json();
  const mediaByKey = new Map((body.includes?.media ?? []).map((m) => [m.media_key, m]));
  const posts = (body.data ?? []).map((tweet) => ({
    tweet,
    media: (tweet.attachments?.media_keys ?? []).map((k) => mediaByKey.get(k)).filter(Boolean),
  }));
  return { posts, nextToken: body.meta?.next_token ?? null };
}
