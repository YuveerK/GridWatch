import { describe, expect, it } from 'vitest';
import { buildMessage, classifyChange, inQuietHours, stateAround } from '../../src/modules/push/events.js';

const st = (status, pct = null) => ({ status, restorationPercent: pct });

describe('which outage changes are worth a message', () => {
  it('a new outage, and new planned work', () => {
    expect(classifyChange({ before: null, after: st('ACTIVE'), kind: 'UNPLANNED' })).toBe('NEW_OUTAGE');
    expect(classifyChange({ before: null, after: st('PLANNED'), kind: 'PLANNED' })).toBe('PLANNED_NEW');
  });
  it('an outage first seen as already restored tells nobody anything', () => {
    expect(classifyChange({ before: null, after: st('RESTORED', 100), kind: 'UNPLANNED' })).toBeNull();
  });
  it('a restoration, and a partial restoration that is new or has moved on by 10 points', () => {
    expect(classifyChange({ before: st('ACTIVE'), after: st('RESTORED', 100), kind: 'UNPLANNED' })).toBe('RESTORED');
    expect(classifyChange({ before: st('ACTIVE'), after: st('PARTIALLY_RESTORED', 48), kind: 'UNPLANNED' })).toBe('PARTIAL');
    expect(classifyChange({ before: st('PARTIALLY_RESTORED', 48), after: st('PARTIALLY_RESTORED', 75), kind: 'UNPLANNED' })).toBe('PARTIAL');
  });
  it('an ordinary update, a small step, a repeated restoration and a repeated reminder are silent', () => {
    expect(classifyChange({ before: st('ACTIVE'), after: st('ACTIVE'), kind: 'UNPLANNED' })).toBeNull();
    expect(classifyChange({ before: st('PARTIALLY_RESTORED', 88), after: st('PARTIALLY_RESTORED', 92), kind: 'UNPLANNED' })).toBeNull();
    expect(classifyChange({ before: st('RESTORED', 100), after: st('RESTORED', 100), kind: 'UNPLANNED' })).toBeNull();
    expect(classifyChange({ before: st('PLANNED'), after: st('PLANNED'), kind: 'PLANNED' })).toBeNull();
  });
});

describe('the words on the phone', () => {
  it('always says it is what City Power reported, and stays short', () => {
    const m = buildMessage({ kind: 'PARTIAL', place: 'Hillbrow', outageTitle: 'Fort', summary: 'Fort Substation is 98% restored.', percent: 98 });
    expect(m.title).toBe('Hillbrow: power partly restored (98%)');
    expect(m.body).toBe('City Power reports: Fort Substation is 98% restored.');
    expect(buildMessage({ kind: 'RESTORED', place: 'X', outageTitle: 'T', summary: 'y'.repeat(400) }).body.length).toBeLessThanOrEqual(178);
  });
  it('has a sensible line when there is no summary', () => {
    expect(buildMessage({ kind: 'NEW_OUTAGE', place: 'Hillbrow', outageTitle: 'Fort (Hillbrow)', summary: null }).body).toBe('City Power reports an update on Fort (Hillbrow).');
  });
});

describe('quiet hours (Johannesburg time, UTC+2)', () => {
  const at = (utcHour) => new Date(Date.UTC(2026, 8, 21, utcHour, 0));
  it('a window that wraps midnight', () => {
    expect(inQuietHours(at(21), 22, 6)).toBe(true); // 23:00 SAST
    expect(inQuietHours(at(3), 22, 6)).toBe(true); // 05:00 SAST
    expect(inQuietHours(at(6), 22, 6)).toBe(false); // 08:00 SAST
  });
  it('a same-day window, and none set', () => {
    expect(inQuietHours(at(8), 9, 17)).toBe(true); // 10:00
    expect(inQuietHours(at(16), 9, 17)).toBe(false); // 18:00
    expect(inQuietHours(at(8), null, null)).toBe(false);
  });
});

describe('the outage before and after one post', () => {
  const eff = (status, extra = {}) => ({ status, pct: null, cause: null, eta: null, headlineLocalities: [], locs: [], nodeIds: [], expand: true, retroactive: false, ...extra });
  const posts = [
    { postId: 'a', faultIndex: 0, postedAt: new Date('2026-09-20T10:00:00Z'), effect: eff('INVESTIGATING') },
    { postId: 'b', faultIndex: 0, postedAt: new Date('2026-09-20T12:00:00Z'), effect: eff('PARTIALLY_RESTORED', { pct: 80 }) },
  ];
  it('the first post has no before; a later one sees what came earlier only', () => {
    expect(stateAround(posts, 'a', 0).before).toBeNull();
    const s = stateAround(posts, 'b', 0);
    expect(s.before.status).toBe('ACTIVE');
    expect(s.after.status).toBe('PARTIALLY_RESTORED');
    expect(s.after.restorationPercent).toBe(80);
  });
});
