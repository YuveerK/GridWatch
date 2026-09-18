import { AppError } from "../../lib/errors.js";

const API_ROOT = "https://api.x.com/2";

export function createXClient({ token, timeoutMs = 20_000, fetchImpl = fetch }) {
  async function request(path, query = {}) {
    if (!token) throw new AppError(503, "X_NOT_CONFIGURED", "X_API_BEARER_TOKEN is not configured");
    const url = new URL(`${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new AppError(response.status === 429 ? 429 : 502, response.status === 429 ? "X_RATE_LIMIT" : "X_API_ERROR", body?.detail ?? body?.title ?? "X API request failed", body);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listPosts({ userId, sinceId, paginationToken }) {
      return request(`/users/${encodeURIComponent(userId)}/tweets`, { since_id: sinceId, pagination_token: paginationToken, max_results: 100, expansions: "attachments.media_keys", "tweet.fields": "author_id,conversation_id,created_at,lang,note_tweet,public_metrics,attachments", "media.fields": "media_key,type,url,width,height,duration_ms,preview_image_url" });
    },
  };
}
