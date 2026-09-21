import { describe, expect, it } from 'vitest';
import { checkState, evaluatePairs, mergePairs, pairKey, pairsFromOverrides } from '../../src/modules/outages/corrections.js';

describe('B5: a correction becomes a test case', () => {
  const rows = [
    { postExternalId: '111', faultIndex: 0, action: 'JOIN', anchorExternalId: '222', anchorFaultIndex: 0, note: 'same fault' },
    { postExternalId: '333', faultIndex: 2, action: 'JOIN', anchorExternalId: '444', anchorFaultIndex: 1, note: null },
    { postExternalId: '555', faultIndex: 0, action: 'SPLIT', contrastExternalId: '666', note: 'a different fault' },
    { postExternalId: '777', faultIndex: 0, action: 'SPLIT', contrastExternalId: null },
  ];
  it('a join is a "same" pair, a split with a contrast post is a "different" pair, and a bare split says it needs one', () => {
    const { pairs, needContrast } = pairsFromOverrides(rows);
    expect(pairs).toEqual([
      { a: '111', b: '222', same: true, why: 'same fault' },
      { a: '333', fa: 2, b: '444', fb: 1, same: true, why: 'a manual correction' },
      { a: '555', b: '666', same: false, why: 'a different fault' },
    ]);
    expect(needContrast).toEqual(['777']);
  });
  it('merging never duplicates a pair, whichever way round it is written, and keeps the existing wording', () => {
    const existing = [{ a: '111', b: '222', same: true, why: 'first wording' }];
    const { pairs, added } = mergePairs(existing, [{ a: '222', b: '111', same: true, why: 'second wording' }, { a: '111', b: '222', same: false, why: 'the opposite claim is a different test' }]);
    expect(added).toHaveLength(1);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].why).toBe('first wording');
    expect(pairKey({ a: '1', b: '2', same: true })).toBe(pairKey({ a: '2', b: '1', same: true }));
  });
});

describe('B5: checking pairs against where posts are', () => {
  const where = { '1': new Set(['o1']), '2': new Set(['o1']), '3': new Set(['o2']), '4': new Set(), '5#1': new Set(['o1']) };
  const outagesOf = (id, fault) => where[fault != null ? `${id}#${fault}` : id] ?? null;
  it('same pairs need a shared outage, different pairs need none', () => {
    const r = evaluatePairs([{ a: '1', b: '2', same: true }, { a: '1', b: '3', same: true }, { a: '1', b: '3', same: false }, { a: '1', b: '2', same: false }], outagesOf);
    expect(r.passed).toHaveLength(2);
    expect(r.failed.map((f) => f.reason)).toEqual(['should be in the same outage but are in different ones', 'must be in different outages but share one']);
  });
  it('a post in no outage fails, and a missing post is reported as unknown, never a silent pass', () => {
    const r = evaluatePairs([{ a: '1', b: '4', same: true }, { a: '1', b: '9', same: true }], outagesOf);
    expect(r.failed[0].reason).toMatch(/in no outage/);
    expect(r.unknown[0].reason).toMatch(/not found: 9/);
    expect(r.passed).toHaveLength(0);
  });
  it('a fault index narrows the post to that one item', () => {
    expect(evaluatePairs([{ a: '5', fa: 1, b: '1', same: true }], outagesOf).passed).toHaveLength(1);
  });
});

describe('B5: final-state expectations', () => {
  const outage = { status: 'PLANNED', kind: 'PLANNED', title: 'Klipfontein (Klipfontein)', postCount: 12, scheduledStart: new Date('2026-09-22T07:00:00Z'), scheduledEnd: new Date('2026-09-23T15:00:00Z') };
  it('a window is compared in Johannesburg time', () => {
    expect(checkState({ expect: { kind: 'PLANNED', window: { start: '2026-09-22 09:00', end: '2026-09-23 17:00' } } }, outage)).toEqual([]);
    expect(checkState({ expect: { window: { start: '2026-09-21 09:00', end: '2026-09-21 17:00' } } }, outage)[0]).toMatch(/window is 2026-09-22 09:00 -> 2026-09-23 17:00, expected/);
  });
  it('status, one-of status, kind, size and title are each checked', () => {
    expect(checkState({ expect: { status: 'RESTORED' } }, outage)[0]).toMatch(/status is PLANNED/);
    expect(checkState({ expect: { statusIn: ['CANCELLED', 'CLOSED'] } }, outage)[0]).toMatch(/one of/);
    expect(checkState({ expect: { kind: 'UNPLANNED' } }, outage)[0]).toMatch(/kind is PLANNED/);
    expect(checkState({ expect: { minPosts: 20 } }, outage)[0]).toMatch(/at least 20/);
    expect(checkState({ expect: { titleIncludes: 'greenstone' } }, outage)[0]).toMatch(/lacks/);
    expect(checkState({ expect: { statusIn: ['PLANNED'], minPosts: 10, titleIncludes: 'KLIP' } }, outage)).toEqual([]);
  });
  it('a post in no outage is reported', () => {
    expect(checkState({ expect: { status: 'RESTORED' } }, null)).toEqual(['the post is in no outage']);
  });
});
