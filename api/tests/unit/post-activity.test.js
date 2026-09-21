import { describe, expect, it } from 'vitest';
import { buildDaily, categoryOf, readable, sastDay, sastDayRange } from '../../src/modules/api/post-activity.service.js';

describe('which kind of post it is', () => {
  it('from how it was processed and what the reading said', () => {
    expect(categoryOf('RELEVANT', 'OUTAGE')).toBe('OUTAGE');
    expect(categoryOf('RELEVANT', 'UPDATE')).toBe('UPDATE');
    expect(categoryOf('RELEVANT', 'RESTORATION')).toBe('RESTORATION');
    expect(categoryOf('RELEVANT', 'PLANNED_OUTAGE')).toBe('PLANNED');
    expect(categoryOf('RELEVANT', 'SDC_SUMMARY')).toBe('SUMMARY');
    expect(categoryOf('GENERAL_NOTICE', 'SDC_SUMMARY')).toBe('SUMMARY');
    expect(categoryOf('GENERAL_NOTICE', 'GENERAL_NOTICE')).toBe('NOTICE');
    expect(categoryOf('IRRELEVANT', null)).toBe('OTHER');
    expect(categoryOf('UNPROCESSED', null)).toBe('OTHER');
  });
  it('a reply to a customer is its own kind whatever the reading says', () => {
    expect(categoryOf('IRRELEVANT', null, true)).toBe('REPLY');
    expect(categoryOf('RELEVANT', 'UPDATE', true)).toBe('REPLY');
  });
});

describe('Johannesburg days', () => {
  it('a post at 22:00 UTC belongs to the next Johannesburg day', () => {
    expect(sastDay('2026-09-20T21:59:00Z')).toBe('2026-09-20');
    expect(sastDay('2026-09-20T22:00:00Z')).toBe('2026-09-21');
  });
  it('a day runs from 22:00 UTC to 22:00 UTC', () => {
    const { start, end } = sastDayRange('2026-09-21');
    expect(start.toISOString()).toBe('2026-09-20T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-21T22:00:00.000Z');
  });
});

describe('counts per day', () => {
  const now = new Date('2026-09-21T10:00:00Z');
  const rows = [
    { day: '2026-09-21', ps: 'RELEVANT', rel: 'OUTAGE', reply: false, n: 3 },
    { day: '2026-09-21', ps: 'IRRELEVANT', rel: null, reply: true, n: 2 },
    { day: '2026-09-19', ps: 'GENERAL_NOTICE', rel: 'GENERAL_NOTICE', reply: false, n: 4 },
    { day: '2026-09-01', ps: 'RELEVANT', rel: 'UPDATE', reply: false, n: 9 }, // outside the window: ignored
  ];
  const d = buildDaily(rows, { days: 3, now });

  it('one entry per day of the window, oldest first, empty days included', () => {
    expect(d.map((x) => x.date)).toEqual(['2026-09-19', '2026-09-20', '2026-09-21']);
    expect(d[1].total).toBe(0);
  });
  it('totals and per-kind counts add up', () => {
    expect(d[2]).toMatchObject({ total: 5, byCategory: { OUTAGE: 3, REPLY: 2, NOTICE: 0 } });
    expect(d[0]).toMatchObject({ total: 4, byCategory: { NOTICE: 4 } });
  });
});

describe('the post as a person reads it', () => {
  it('drops the leading hashtags, links and sign-offs, and shortens long posts', () => {
    expect(readable('#CityPowerUpdates #CityPowerOutages #InnerCitySDC Fort Substation is 98% restored. ^ZD https://t.co/abc')).toBe('Fort Substation is 98% restored.');
    expect(readable('x'.repeat(500), 100).length).toBeLessThanOrEqual(100);
  });
});
