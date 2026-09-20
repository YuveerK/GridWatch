import { describe, expect, it } from 'vitest';
import { categorize } from '../../src/lib/fault-category.js';
import { buildInsights } from '../../src/modules/api/insights.service.js';

describe('fault categories', () => {
  it.each([
    ['cable fault', 'CABLE'],
    ['faulty cable', 'CABLE'],
    ['multiple cable faults', 'CABLE'],
    ['faulty feeder cable', 'CABLE'],
    ['cable theft', 'THEFT_VANDALISM'],
    ['vandalism', 'THEFT_VANDALISM'],
    ['vandalised transformer', 'THEFT_VANDALISM'],
    ['faulty transformer', 'EQUIPMENT'],
    ['incomer breaker tripped on arc protection', 'EQUIPMENT'],
    ['tripped distributor', 'EQUIPMENT'],
    ['emergency isolation', 'MAINTENANCE'],
    ['essential maintenance work', 'MAINTENANCE'],
    ['car crash damaged the mini-substation', 'EXTERNAL'],
    ['overloaded network', 'OVERLOAD'],
    ['something nobody expected', 'OTHER'],
    ['', 'UNKNOWN'],
    [null, 'UNKNOWN'],
  ])('%s -> %s', (cause, id) => expect(categorize(cause)).toBe(id));
});

describe('buildInsights', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const at = (h) => new Date(now.getTime() - h * 3_600_000);
  const o = (id, cause, sdcName, startH, restoreH = null) => ({ id, title: id, sdcName, cause, status: 'ACTIVE', startedAt: at(startH), restoredAt: restoreH == null ? null : at(restoreH) });
  const outages = [o('a', 'cable fault', 'Roodepoort', 30, 26), o('b', 'faulty cable', 'Roodepoort', 20, 10), o('c', 'cable theft', 'Lenasia', 10), o('d', null, 'Lenasia', 5), o('e', 'cable fault', 'Roodepoort', 4, 1)];
  const equipment = [
    { outageId: 'a', nodeId: 'n1', name: 'Hub', type: 'SUBSTATION' },
    { outageId: 'b', nodeId: 'n1', name: 'Hub', type: 'SUBSTATION' },
    { outageId: 'c', nodeId: 'n2', name: 'Solo', type: 'SUBSTATION' },
  ];
  const r = buildInsights({ outages, equipment, days: 3, now });

  it('counts and shares by category, with unknown last', () => {
    expect(r.total).toBe(5);
    expect(r.causes.map((c) => [c.id, c.count])).toEqual([['CABLE', 3], ['THEFT_VANDALISM', 1], ['UNKNOWN', 1]]);
    expect(r.causes[0].share).toBeCloseTo(0.6);
    expect(r.unknownShare).toBeCloseTo(0.2);
    expect(r.causes[0].wordings[0]).toEqual({ text: 'cable fault', count: 2 });
  });
  it('a zero-filled per-day trend for each category', () => {
    expect(r.trend[0].days).toHaveLength(3);
    expect(r.trend.find((t) => t.id === 'CABLE').days.reduce((n, d) => n + d.count, 0)).toBe(3);
  });
  it('cause by service centre, with each centre top stated cause', () => {
    expect(r.byArea.find((a) => a.sdc === 'Roodepoort')).toMatchObject({ total: 3, topCause: { id: 'CABLE', count: 3 } });
    expect(r.byArea.find((a) => a.sdc === 'Lenasia').topCause.id).toBe('THEFT_VANDALISM'); // unknown never counts as a top cause
  });
  it('restoration times: a median only when there are enough cases to call it typical', () => {
    expect(r.restore.byCause.find((c) => c.id === 'CABLE')).toEqual({ id: 'CABLE', label: 'Cable fault', n: 3, medianHours: 4 });
    expect(r.restore.byCause.find((c) => c.id === 'THEFT_VANDALISM')).toBeUndefined(); // never restored: nothing to time
    const few = buildInsights({ outages: [o('x', 'cable fault', 'A', 10, 5)], days: 3, now });
    expect(few.restore.byCause[0]).toMatchObject({ n: 1, medianHours: null });
  });
  it('a long repair saga (over 3 days) is not part of the typical time, and is counted', () => {
    const long = buildInsights({ outages: [o('a', 'cable fault', 'A', 10, 8), o('b', 'cable fault', 'A', 20, 16), o('c', 'cable fault', 'A', 30, 24), o('d', 'cable fault', 'A', 300, 30)], days: 30, now });
    expect(long.restore.byCause.find((c) => c.id === 'CABLE')).toMatchObject({ n: 3, medianHours: 4 });
    expect(long.restore.longExcluded).toBe(1);
  });
  it('equipment that failed more than once', () => {
    expect(r.repeat).toEqual([{ id: 'n1', name: 'Hub', type: 'SUBSTATION', sdc: 'Roodepoort', count: 2, causes: [{ id: 'CABLE', label: 'Cable fault', count: 2 }] }]);
  });
  it('an empty window is fine', () => {
    const e = buildInsights({ outages: [], days: 7, now });
    expect(e.total).toBe(0);
    expect(e.causes).toEqual([]);
    expect(e.unknownShare).toBe(0);
  });
});

describe('history, week-on-week and unsorted wordings', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const day = (n) => new Date(now.getTime() - n * 24 * 3_600_000);
  const mk = (id, cause, ago) => ({ id, title: id, sdcName: 'A', cause, status: 'ACTIVE', startedAt: day(ago), restoredAt: null });

  it('says how many days of history it stands on, and holds the comparison back until there are 14', () => {
    const young = buildInsights({ outages: [mk('a', 'cable fault', 2)], days: 14, now, earliest: day(10) });
    expect(young.dataDays).toBe(10);
    expect(young.weekly.available).toBe(false);
  });
  it('compares this week with last week once there is enough history', () => {
    const outages = [];
    for (let i = 0; i < 10; i++) outages.push(mk(`p${i}`, 'cable fault', 8 + (i % 5))); // last week: 10 cable faults
    for (let i = 0; i < 6; i++) outages.push(mk(`c${i}`, i < 4 ? 'cable fault' : 'vandalism', 1 + (i % 5))); // this week
    const r = buildInsights({ outages, days: 30, now, earliest: day(20) });
    expect(r.weekly).toMatchObject({ available: true, thisWeek: 6, lastWeek: 10 });
    expect(r.weekly.byCause.find((c) => c.id === 'CABLE')).toMatchObject({ thisWeek: 4, lastWeek: 10 });
    expect(r.weekly.byCause.find((c) => c.id === 'THEFT_VANDALISM')).toMatchObject({ thisWeek: 2, lastWeek: 0 });
  });
  it('lists stated causes no rule could sort, most common first, so the rules can be improved', () => {
    const r = buildInsights({ outages: [mk('a', 'unforeseen circumstances', 1), mk('b', 'unforeseen circumstances', 2), mk('c', 'a weird one', 1), mk('d', 'cable fault', 1)], days: 7, now });
    expect(r.unsorted).toEqual([{ text: 'unforeseen circumstances', count: 2 }, { text: 'a weird one', count: 1 }]);
  });
  it('outages older than the window still feed the comparison but not the main numbers', () => {
    const r = buildInsights({ outages: [mk('old', 'cable fault', 10), mk('new', 'cable fault', 1)], days: 3, now, earliest: day(30) });
    expect(r.total).toBe(1);
    expect(r.weekly.lastWeek).toBe(1);
  });
});
