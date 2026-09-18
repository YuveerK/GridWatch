import { describe, expect, it } from 'vitest';
import { scoreCandidate } from '../../src/modules/outages/scoring.js';

const t0 = new Date('2026-09-16T08:00:00Z');
const hoursLater = (h) => new Date(t0.getTime() + h * 3_600_000);

const outage = (over = {}) => ({
  kind: 'UNPLANNED',
  status: 'ACTIVE',
  nodeIds: new Set(['n1']),
  localityIds: new Set(['l1', 'l2']),
  sdcName: 'Roodepoort',
  conversationIds: new Set(),
  lastUpdateAt: t0,
  restoredAt: null,
  ...over,
});

const post = (over = {}) => ({
  kind: 'UNPLANNED',
  relevance: 'UPDATE',
  status: 'REPAIRING',
  nodeIds: new Set(['n1']),
  relatedNodeIds: new Set(),
  localityIds: new Set(['l1']),
  sdcName: 'Roodepoort',
  conversationId: null,
  postedAt: hoursLater(2),
  ...over,
});

describe('scoreCandidate', () => {
  it('links an update sharing node and locality with an active outage', () => {
    expect(scoreCandidate(post(), outage()).score).toBeGreaterThanOrEqual(0.7);
  });

  it('scores zero when nothing is shared', () => {
    const r = scoreCandidate(post({ nodeIds: new Set(['x']), localityIds: new Set(['y']) }), outage());
    expect(r.score).toBe(0);
  });

  it('treats a new fault right after restoration as a different outage', () => {
    const restored = outage({ status: 'RESTORED', restoredAt: hoursLater(1), lastUpdateAt: hoursLater(1) });
    const r = scoreCandidate(post({ relevance: 'OUTAGE', postedAt: hoursLater(20) }), restored);
    expect(r.score).toBeLessThan(0.7);
  });

  it('still attaches a restoration post to a recently restored outage', () => {
    const restored = outage({ status: 'RESTORED', restoredAt: hoursLater(1), lastUpdateAt: hoursLater(1) });
    const r = scoreCandidate(post({ relevance: 'RESTORATION', postedAt: hoursLater(2) }), restored);
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });

  it('penalises planned vs unplanned mismatch and different SDC', () => {
    const r = scoreCandidate(post({ kind: 'PLANNED', sdcName: 'Midrand' }), outage());
    expect(r.score).toBeLessThan(0.5);
  });

  it('uses the thread as a strong signal', () => {
    const r = scoreCandidate(
      post({ nodeIds: new Set(), localityIds: new Set(['l1']), conversationId: 'c1' }),
      outage({ conversationIds: new Set(['c1']) }),
    );
    expect(r.reasons).toContain('same thread');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });
});
