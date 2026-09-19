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

describe('amended posts', () => {
  const other = { nodeIds: new Set(['other']), relatedNodeIds: new Set(), localityIds: new Set(['l1']) };
  it('lifts a same-suburb post with different equipment into the tie-break band, but only when it says it is amended', () => {
    const plain = scoreCandidate(post(other), outage()).score;
    const amended = scoreCandidate(post({ ...other, amended: true }), outage()).score;
    expect(plain).toBeLessThan(0.35); // different equipment, one shared suburb: a new outage
    expect(amended).toBeGreaterThanOrEqual(0.35);
    expect(amended).toBeLessThan(0.7); // still not decided here
  });
  it('does nothing when it shares no suburb or equipment, or the outage is old', () => {
    expect(scoreCandidate(post({ nodeIds: new Set(['x']), localityIds: new Set(['y']), amended: true }), outage()).score).toBe(0);
    expect(scoreCandidate(post({ ...other, amended: true, postedAt: hoursLater(30) }), outage()).score).toBeLessThan(0.35);
  });
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

  it('never links planned with unplanned', () => {
    expect(scoreCandidate(post({ kind: 'PLANNED' }), outage()).score).toBe(0);
  });

  it('penalises a different SDC', () => {
    const r = scoreCandidate(post({ sdcName: 'Midrand' }), outage());
    expect(r.score).toBeLessThan(scoreCandidate(post(), outage()).score);
  });

  it('does not glue a single-node post to a sprawling multi-node outage', () => {
    const big = outage({ nodeIds: new Set(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']), localityIds: new Set() });
    const r = scoreCandidate(post({ localityIds: new Set() }), big);
    expect(r.score).toBeLessThan(0.7);
  });

  it('never attaches a restoration to an outage restored more than 6h earlier', () => {
    const restored = outage({ status: 'RESTORED', restoredAt: hoursLater(1), lastUpdateAt: hoursLater(1) });
    expect(scoreCandidate(post({ relevance: 'RESTORATION', postedAt: hoursLater(9) }), restored).score).toBe(0);
  });

  it('attaches a repeated cancellation to the cancelled outage but not other posts', () => {
    const cancelled = outage({ status: 'CANCELLED' });
    expect(scoreCandidate(post({ status: 'CANCELLED', relevance: 'PLANNED_OUTAGE' }), cancelled).score).toBeGreaterThanOrEqual(0.7);
    expect(scoreCandidate(post(), cancelled).score).toBeLessThan(0.7);
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
