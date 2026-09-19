import { useEffect, useSyncExternalStore } from 'react';
import { get } from './api.js';

const BASE = import.meta.env.VITE_API_URL ?? '';
export const REFRESHED_EVENT = 'gridwatch:refreshed';

/**
 * Shared state for the "fetch latest posts" button, so every place that shows it (header, overview)
 * agrees. The server owns the truth (it may already be running from a scheduler or another tab);
 * we poll it while a cycle is running and tell the pages to reload when it finishes.
 */
let snap = { loaded: false, enabled: true, state: 'idle', receivedAt: 0 };
const listeners = new Set();
let timer = null;
let inflight = false;

function publish(next) {
  snap = { ...snap, ...next, loaded: true, receivedAt: Date.now() };
  listeners.forEach((l) => l());
}

function apply(server, extra = {}) {
  const wasRunning = snap.state === 'running';
  publish({ ...server, ...extra, notice: extra.notice ?? null });
  if (server.state === 'running' && !timer) timer = setInterval(poll, 600); // short runs finish in a few seconds: poll fast enough to be seen
  if (server.state !== 'running' && timer) {
    clearInterval(timer);
    timer = null;
    if (wasRunning && server.state === 'done') {
      window.dispatchEvent(new Event(REFRESHED_EVENT));
      setTimeout(poll, 300); // pick up the new "latest batch" time
    }
  }
}

async function poll() {
  if (inflight) return;
  inflight = true;
  try {
    apply(await get('/v1/refresh'));
  } catch {
    /* the server may be restarting; keep the last known state and try again */
  } finally {
    inflight = false;
  }
}

export async function startRefresh() {
  try {
    const res = await fetch(`${BASE}/v1/refresh`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) return publish({ enabled: false });
    if (res.status === 429) return apply({ ...snap, ...body }, { notice: 'cooldown' });
    if (res.status === 409) return apply(body, { notice: 'running' });
    if (!res.ok) return publish({ state: 'error', error: body.error ?? 'Could not start the refresh.' });
    apply(body);
  } catch {
    publish({ state: 'error', error: "Couldn't reach the server. Is the API running?" });
  }
}

const subscribe = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useRefresh() {
  const value = useSyncExternalStore(subscribe, () => snap);
  useEffect(() => {
    if (!snap.loaded) poll();
  }, []);
  return value;
}

/** Whole seconds until a manual refresh is allowed again (0 = now). */
export function cooldownSeconds(s) {
  if (!s.cooldownUntil || !s.now) return 0;
  const left = s.cooldownUntil - s.now - (Date.now() - s.receivedAt);
  return Math.max(0, Math.ceil(left / 1000));
}

export function describeResult(r) {
  if (!r) return '';
  if (r.newPosts === 0) return 'No new posts from City Power.';
  const bits = [`${r.newPosts} new post${r.newPosts === 1 ? '' : 's'}`];
  if (r.newOutages) bits.push(`${r.newOutages} new outage${r.newOutages === 1 ? '' : 's'}`);
  if (r.updates) bits.push(`${r.updates} update${r.updates === 1 ? '' : 's'}`);
  const failed = r.failed ? ` ${r.failed} could not be read this time and will be retried on the next fetch.` : '';
  return `${bits.join(' · ')}.${failed}${r.capped ? ' More are waiting: fetch again.' : ''}`;
}
