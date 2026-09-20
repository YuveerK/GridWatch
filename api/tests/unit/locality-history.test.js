import { describe, expect, it } from 'vitest';
import { buildLocalityHistory } from '../../src/modules/api/locality-history.service.js';

const now = new Date('2026-09-20T12:00:00Z');
const at = (h) => new Date(now.getTime() - h * 3_600_000);
const o = (id, cause, startH, endH, extra = {}) => ({ id, title: id, kind: 'UNPLANNED', status: endH == null ? 'ACTIVE' : 'RESTORED', cause, startedAt: at(startH), restoredAt: endH == null ? null : at(endH), equipment: ['Panorama'], alsoAffected: ['Wilgeheuwel'], ...extra });

describe('a suburb\'s outage history', () => {
  const r = buildLocalityHistory({
    outages: [o('a', 'cable fault', 100, 96), o('b', 'faulty cable', 60, 50), o('c', 'cable fault', 30, 20), o('d', 'cable theft', 10, 9), o('e', null, 3, null), o('p', null, 200, 190, { kind: 'PLANNED', cause: 'planned maintenance' })],
    days: 90,
    now,
    earliest: at(24 * 12),
  });

  it('lists newest first with the duration in hours and nothing for an unrestored outage', () => {
    expect(r.rows.map((x) => x.id)).toEqual(['e', 'd', 'c', 'b', 'a', 'p']);
    expect(r.rows.find((x) => x.id === 'a').durationHours).toBe(4);
    expect(r.rows.find((x) => x.id === 'e').durationHours).toBeNull();
  });
  it('counts faults and planned work separately', () => {
    expect(r).toMatchObject({ total: 6, faults: 5, planned: 1, dataDays: 12 });
  });
  it('a typical time to restore, only from restored faults and only with enough of them', () => {
    expect(r.typical).toMatchObject({ restored: 4, medianHours: 7 }); // 4, 10, 10, 1 -> median of (1,4,10,10) = 7
    const few = buildLocalityHistory({ outages: [o('x', 'cable fault', 10, 5)], days: 90, now });
    expect(few.typical.medianHours).toBeNull();
  });
  it('the usual cause and the equipment that keeps appearing', () => {
    expect(r.typical.topCause).toMatchObject({ id: 'CABLE', count: 3 });
    expect(r.typical.topEquipment).toEqual({ name: 'Panorama', count: 5 });
  });
  it('typical time by cause needs 3 restored cases; fewer says nothing', () => {
    expect(r.byCause.find((c) => c.id === 'CABLE')).toMatchObject({ outages: 3, restored: 3, medianHours: 10 });
    expect(r.byCause.find((c) => c.id === 'THEFT_VANDALISM').medianHours).toBeNull();
  });
  it('an outage first seen as a restoration has no start, so no duration and no effect on what is typical', () => {
    const r = buildLocalityHistory({ outages: [o('a', 'cable fault', 100, 96), o('b', 'cable fault', 60, 50), o('c', 'cable fault', 30, 20), o('r', 'cable fault', 5, 4.99, { retroactive: true })], days: 90, now });
    expect(r.rows.find((x) => x.id === 'r').durationHours).toBeNull();
    expect(r.typical).toMatchObject({ restored: 3, medianHours: 10 });
  });
  it('an empty suburb is fine', () => {
    const e = buildLocalityHistory({ outages: [], days: 90, now });
    expect(e.total).toBe(0);
    expect(e.typical.medianHours).toBeNull();
    expect(e.typical.topCause).toBeNull();
  });
});
