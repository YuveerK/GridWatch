import { createHash } from 'node:crypto';

// What makes a change worth a person's (or an independent check's) time. Pure helpers; the database queries are in review.service.js.
// The queue never changes an outage: it only points at things that look wrong so nobody has to read every post to find them.

/** Reason codes and how much attention each deserves (higher = look sooner). */
export const REASONS = {
  NEW_NEAR_ACTIVE: { weight: 3, label: 'opened a new outage next to a similar one that is still live' },
  RESTORATION_SPLIT_FROM_INCIDENT: { weight: 3, label: 'a restoration opened its own outage although a similar incident exists' },
  KIND_CONFLICT: { weight: 3, label: 'a similar outage of the other kind (planned/unplanned) exists nearby' },
  DISCARDED_FAULT: { weight: 2, label: 'a fault of this post produced no outage' },
  EQUIPMENT_IDENTITY: { weight: 2, label: 'a new piece of equipment has a name very like a known one' },
  UNCERTAIN_READING: { weight: 2, label: 'the reading was uncertain, or a picture could not be read' },
  CHANGED_SCOPE: { weight: 1, label: 'this post added many new suburbs to an existing outage' },
  RESTORATION_NO_PRECEDING_INCIDENT: { weight: 1, label: 'a restoration with no earlier incident on record' },
  TIEBREAK_GAVE_UP: { weight: 3, label: 'the AI tie-break kept failing; the decision needs a person' },
  SAMPLE: { weight: 0, label: 'a routine spot check of an apparently clean post' },
};

/** The priority of an item: the sum of its reasons' weights (a verifier disagreement adds 5, applied where it is recorded). */
export const priorityOf = (reasons) => reasons.reduce((n, r) => n + (REASONS[r.code]?.weight ?? 1), 0);

/**
 * Deterministic sampling of clean posts (about `rate` of them per day) to notice blind spots: the same post on the same day is always in or out.
 */
export function isSampled(postId, rate, day) {
  if (!(rate > 0)) return false;
  const h = createHash('sha256').update(`${postId}|${day}`).digest();
  return h.readUInt32BE(0) / 0xffffffff < rate;
}

const flat = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Is `quote` (at least a few words) really in one of the sources, word for word (case and spacing aside)? */
export function quoteAppears(quote, ...sources) {
  const q = flat(quote);
  if (q.length < 8) return false;
  return sources.some((s) => flat(s).includes(q));
}
