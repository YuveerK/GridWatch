import { env } from '../../config/env.js';

const BASE = 'https://api.x.com/2';

export class XRateLimitError extends Error {
  constructor(resetAt) {
    super('X API rate limited');
    this.resetAt = resetAt;
  }
}

const TWEET_FIELDS = 'created_at,lang,public_metrics,conversation_id,note_tweet,attachments,referenced_tweets,entities';

/**
 * Fetch one page of an account's posts newer than `sinceId` (newest first).
 * Returns { posts: [{ tweet, media: [] }], nextToken }.
 */
export async function fetchTimelinePage({ userId, sinceId, paginationToken }) {
  if (!env.X_API_BEARER_TOKEN) throw new Error('X_API_BEARER_TOKEN is not set');
  const params = new URLSearchParams({
    max_results: '100',
    exclude: 'retweets',
    'tweet.fields': TWEET_FIELDS,
    expansions: 'attachments.media_keys',
    'media.fields': 'media_key,type,url,width,height,duration_ms,preview_image_url',
  });
  if (sinceId) params.set('since_id', sinceId);
  if (paginationToken) params.set('pagination_token', paginationToken);

  const res = await fetch(`${BASE}/users/${userId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${env.X_API_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    throw new XRateLimitError(reset ? new Date(reset * 1000) : null);
  }
  if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.json();
  const mediaByKey = new Map((body.includes?.media ?? []).map((m) => [m.media_key, m]));
  const posts = (body.data ?? []).map((tweet) => ({
    tweet,
    media: (tweet.attachments?.media_keys ?? []).map((k) => mediaByKey.get(k)).filter(Boolean),
  }));
  return { posts, nextToken: body.meta?.next_token ?? null };
}
