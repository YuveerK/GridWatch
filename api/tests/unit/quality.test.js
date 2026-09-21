import { describe, expect, it } from 'vitest';
import { checkPostDispositions, effectReadingMismatch, ingestionProblems, plannedOverdue, stuckProcessing } from '../../src/modules/processing/quality.js';
import { readingRevision } from '../../src/lib/reading-revision.js';

const linked = (i, outageId = `o${i}`) => ({ faultIndex: i, outcome: 'LINKED', outageId, reason: 'shared node' });
const entry = (i, outageId = `o${i}`) => ({ faultIndex: i, outageId });

describe('E11: every expected fault has exactly one accepted disposition', () => {
  it('a complete, consistent post has no problems', () => {
    const v = checkPostDispositions({ expectedIndices: [0, 1], decisions: [linked(0), linked(1)], outagePosts: [entry(0), entry(1)] });
    expect(v).toEqual({ problems: [], excluded: [] });
  });
  it('a missing fault, a doubled fault and a linked fault with no timeline entry are each reported', () => {
    const v = checkPostDispositions({ expectedIndices: [0, 1, 2], decisions: [linked(0), linked(0), linked(2)], outagePosts: [entry(0)] });
    expect(v.problems).toEqual(expect.arrayContaining(['fault 1 has no disposition', 'fault 0 has 2 dispositions', 'fault 2 says linked but has no timeline entry']));
  });
  it('a fault left out is listed with its reason; one left out with no reason is a problem', () => {
    const ok = checkPostDispositions({ expectedIndices: [0], decisions: [{ faultIndex: 0, outcome: 'NEW', outageId: null, reason: 'digest post covering several faults: no outage created' }], outagePosts: [] });
    expect(ok.excluded).toEqual([{ faultIndex: 0, reason: 'digest post covering several faults: no outage created' }]);
    expect(ok.problems).toEqual([]);
    const bad = checkPostDispositions({ expectedIndices: [0], decisions: [{ faultIndex: 0, outcome: 'NEW', outageId: null, reason: null }], outagePosts: [] });
    expect(bad.problems).toContain('fault 0 was left out with no reason');
  });
  it('a fault that needs review is a problem; leftovers from an older reading are reported', () => {
    expect(checkPostDispositions({ expectedIndices: [0], decisions: [{ faultIndex: 0, outcome: 'NEEDS_REVIEW', reason: 'tie-break failed' }], outagePosts: [] }).problems[0]).toMatch(/needs review/);
    const stale = checkPostDispositions({ expectedIndices: [0], decisions: [linked(0), linked(1)], outagePosts: [entry(0), entry(1)] });
    expect(stale.problems).toEqual(expect.arrayContaining([expect.stringMatching(/disposition exists for fault 1/), expect.stringMatching(/timeline entry exists for fault 1/)]));
  });
});

describe('E10/E11: an effect built from another reading is found', () => {
  const r = { relevance: 'UPDATE', status: 'REPAIRING', entities: [], localities: [], faults: [] };
  it('agrees with the reading it was built from, disagrees after a change, and says nothing for old effects', () => {
    expect(effectReadingMismatch({ reading: readingRevision(r) }, r)).toBe(false);
    expect(effectReadingMismatch({ reading: readingRevision(r) }, { ...r, status: 'RESTORED' })).toBe(true);
    expect(effectReadingMismatch({}, r)).toBeNull();
    expect(effectReadingMismatch(null, r)).toBeNull();
  });
});

describe('E11: planned work that should be closed', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  it('uses the stored window, with a grace period', () => {
    expect(plannedOverdue({ status: 'PLANNED', scheduledEnd: new Date('2026-09-21T05:00:00Z'), lastUpdateAt: new Date(now) }, now)).toBe(true); // ended 7h ago
    expect(plannedOverdue({ status: 'PLANNED', scheduledEnd: new Date('2026-09-21T08:00:00Z'), lastUpdateAt: new Date(now) }, now)).toBe(false); // ended 4h ago
    expect(plannedOverdue({ status: 'PLANNED', scheduledEnd: new Date('2026-09-23T15:00:00Z'), lastUpdateAt: new Date(now - 30 * 24 * 3_600_000) }, now)).toBe(false); // window ahead: age is irrelevant
  });
  it('falls back to age only when no window is known, and ignores other statuses', () => {
    expect(plannedOverdue({ status: 'PLANNED', scheduledEnd: null, lastUpdateAt: new Date(now - 11 * 24 * 3_600_000) }, now)).toBe(true);
    expect(plannedOverdue({ status: 'PLANNED', scheduledEnd: null, lastUpdateAt: new Date(now - 2 * 24 * 3_600_000) }, now)).toBe(false);
    expect(plannedOverdue({ status: 'CLOSED', scheduledEnd: new Date('2026-01-01'), lastUpdateAt: new Date(0) }, now)).toBe(false);
  });
});

describe('E11: stuck work and an unhealthy ingestion position', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  it('a post in PROCESSING for over 30 minutes is stuck', () => {
    const p = (min, status = 'PROCESSING') => ({ processingStatus: status, processingStartedAt: new Date(now - min * 60_000) });
    expect(stuckProcessing([p(45), p(5), p(90, 'RELEVANT')], now)).toHaveLength(1);
  });
  it('an unfinished fetch, no completed fetch, or a stale one are each reported', () => {
    expect(ingestionProblems(null, now)).toHaveLength(1);
    expect(ingestionProblems({ incomplete: false, lastCompletedAt: new Date(now - 60_000) }, now)).toEqual([]);
    expect(ingestionProblems({ incomplete: true, lastCompletedAt: new Date(now - 60_000) }, now)[0]).toMatch(/did not finish/);
    expect(ingestionProblems({ incomplete: false, lastCompletedAt: new Date(now - 7 * 3_600_000) }, now)[0]).toMatch(/over 6 hours/);
    expect(ingestionProblems({ incomplete: false, lastCompletedAt: null }, now)[0]).toMatch(/ever completed/);
  });
});

import { decideStatus } from '../../src/modules/processing/quality.js';

describe('the verdict on a cycle', () => {
  it('COMPLETE only when everything ran and every check passed', () => {
    expect(decideStatus({})).toBe('COMPLETE');
  });
  it('FAILED beats everything; then INCOMPLETE (work missing); then NEEDS_REVIEW (a person is needed)', () => {
    expect(decideStatus({ error: 'boom', problems: 3 })).toBe('FAILED');
    expect(decideStatus({ incomplete: ['sweep'], problems: 3 })).toBe('INCOMPLETE');
    expect(decideStatus({ backlog: 5 })).toBe('INCOMPLETE');
    expect(decideStatus({ ingestionIncomplete: true })).toBe('INCOMPLETE');
    expect(decideStatus({ stuck: 1 })).toBe('INCOMPLETE');
    expect(decideStatus({ problems: 1 })).toBe('NEEDS_REVIEW');
    expect(decideStatus({ needsReview: 2 })).toBe('NEEDS_REVIEW');
  });
});
