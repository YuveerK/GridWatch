import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const URL_SEND = 'https://exp.host/--/api/v2/push/send';
export const TOKEN_SHAPE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/;

/**
 * Send push messages through Expo. Returns one result per message, in order: { ok } or { ok: false, error, invalidToken }.
 * Never throws: a failed send must not break the pipeline. PUSH_DRY_RUN=on logs instead of sending.
 */
export async function sendExpo(messages, { fetchImpl = fetch } = {}) {
  if (!messages.length) return [];
  if (env.PUSH_DRY_RUN === 'on') {
    for (const m of messages) logger.info({ to: `${m.to.slice(0, 22)}…`, title: m.title }, 'push (dry run)');
    return messages.map(() => ({ ok: true, dryRun: true }));
  }
  const results = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetchImpl(URL_SEND, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = await res.json();
      chunk.forEach((_, k) => {
        const t = body.data?.[k];
        if (t?.status === 'ok') results.push({ ok: true });
        else results.push({ ok: false, error: t?.details?.error ?? t?.message ?? 'unknown', invalidToken: t?.details?.error === 'DeviceNotRegistered' });
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'push send failed');
      for (const _ of chunk) results.push({ ok: false, error: err.message });
    }
  }
  return results;
}
