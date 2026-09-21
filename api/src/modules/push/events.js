import { foldEffects } from '../outages/outage-state.js';

/**
 * What an outage change means to someone following a suburb. Pure.
 *   before / after: foldEffects() of the outage's posts without / with this post (before is null for the first post)
 * Returns NEW_OUTAGE | PLANNED_NEW | PARTIAL | RESTORED, or null when the change is not worth a message
 * (an ordinary "still working on it" update, a restoration with no earlier outage, a repeated reminder).
 */
export function classifyChange({ before, after, kind }) {
  if (!after) return null;
  if (!before) {
    if (after.status === 'RESTORED') return null; // first seen as already restored: nobody was told it was out
    return kind === 'PLANNED' || after.status === 'PLANNED' ? 'PLANNED_NEW' : 'NEW_OUTAGE';
  }
  if (after.status === 'RESTORED' && before.status !== 'RESTORED') return 'RESTORED';
  if (after.status === 'PARTIALLY_RESTORED') {
    const rose = (after.restorationPercent ?? 0) - (before.restorationPercent ?? 0) >= 10;
    if (before.status !== 'PARTIALLY_RESTORED' || rose) return 'PARTIAL';
  }
  return null;
}

const TITLES = {
  NEW_OUTAGE: (place) => `${place}: power outage reported`,
  PLANNED_NEW: (place) => `${place}: planned power interruption`,
  PARTIAL: (place, pct) => `${place}: power partly restored${pct ? ` (${pct}%)` : ''}`,
  RESTORED: (place) => `${place}: power restored`,
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

/** The words on the phone. Always attributed to City Power: this is what it reported, not a fact we checked. */
export function buildMessage({ kind, place, outageTitle, summary, percent }) {
  const body = summary ? `City Power reports: ${summary}` : `City Power reports an update on ${outageTitle}.`;
  return { title: TITLES[kind](place, percent), body: clip(body, 178) };
}

/** Is Johannesburg time (UTC+2, no daylight saving) inside a device's quiet hours? The window may wrap midnight. */
export function inQuietHours(now, quietFrom, quietTo) {
  if (quietFrom == null || quietTo == null || quietFrom === quietTo) return false;
  const hour = (now.getUTCHours() + 2) % 24;
  return quietFrom < quietTo ? hour >= quietFrom && hour < quietTo : hour >= quietFrom || hour < quietTo;
}

const order = (a, b) => a.postedAt - b.postedAt || (a.faultIndex ?? 0) - (b.faultIndex ?? 0) || String(a.postId).localeCompare(String(b.postId));

/** The outage's state just before and just after one post, folded from the stored effects. */
export function stateAround(posts, postId, faultIndex) {
  const sorted = [...posts].filter((p) => p.effect).sort(order);
  const i = sorted.findIndex((p) => p.postId === postId && p.faultIndex === faultIndex);
  if (i < 0) return { before: null, after: null };
  return { before: i > 0 ? foldEffects(sorted.slice(0, i)) : null, after: foldEffects(sorted.slice(0, i + 1)) };
}
