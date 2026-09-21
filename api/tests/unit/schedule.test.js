import { describe, expect, it } from 'vitest';
import { parseSchedule } from '../../src/lib/schedule.js';

const ref = new Date('2026-09-10T08:00:00Z');

describe('parseSchedule', () => {
  it('reads a date and colon time window', () => {
    expect(parseSchedule('planned power interruption at Cydna Substation, which is scheduled to take place on Wednesday 16 September 2026 from 09:00 - 17:00.', ref)).toEqual({ date: '2026-09-16', from: '09:00', to: '17:00' });
  });
  it('reads the "09h00 until 17h00" style', () => {
    expect(parseSchedule('scheduled for Thursday 17 September 2026 from 09h00 until 17h00.^LP', ref)).toEqual({ date: '2026-09-17', from: '09:00', to: '17:00' });
  });
  it('defaults the year from the post date and tolerates a missing time', () => {
    expect(parseSchedule('Planned maintenance will take place on 12 October.', ref)).toEqual({ date: '2026-10-12', from: null, to: null });
  });
  it('uses the last date when a post reschedules', () => {
    expect(parseSchedule('initially scheduled for 29 September and now moved to 3 October 2026', ref).date).toBe('2026-10-03');
  });
  it('returns null when there is no date', () => {
    expect(parseSchedule('Customers are reminded of a planned interruption tomorrow.', ref)).toBeNull();
    expect(parseSchedule('', ref)).toBeNull();
  });
});

import { scheduleWindow } from '../../src/lib/schedule.js';

describe('scheduleWindow (A09): the announced window as UTC instants, Johannesburg local time', () => {
  const at = new Date('2026-09-10T08:00:00Z');
  const w = (text, extraction = null, ref = at) => scheduleWindow(extraction, text, ref);
  it('converts SAST to UTC', () => {
    expect(w('planned on 16 September 2026 from 09:00-17:00')).toEqual({ start: '2026-09-16T07:00:00.000Z', end: '2026-09-16T15:00:00.000Z' });
  });
  it('an overnight window ends the next day; no time means the whole local day', () => {
    expect(w('scheduled for 16 September 2026 from 22:00 - 04:00')).toEqual({ start: '2026-09-16T20:00:00.000Z', end: '2026-09-17T02:00:00.000Z' });
    expect(w('planned maintenance on 16 September 2026')).toEqual({ start: '2026-09-15T22:00:00.000Z', end: '2026-09-16T22:00:00.000Z' });
  });
  it('uses the last date and the time stated after it (rescheduling)', () => {
    expect(w('was 09:00-12:00 on 1 October 2026, now moved to 3 October 2026 from 10:00-14:00')).toEqual({ start: '2026-10-03T08:00:00.000Z', end: '2026-10-03T12:00:00.000Z' });
  });
  it('a yearless January notice posted in December is next year; impossible dates and times are rejected', () => {
    expect(w('planned on 5 January', null, new Date('2026-12-20T08:00:00Z')).start).toBe('2027-01-04T22:00:00.000Z');
    expect(w('planned on 31 February 2026')).toBeNull();
    expect(w('planned on 16 September 2026 from 25:00-27:00')).toEqual({ start: '2026-09-15T22:00:00.000Z', end: '2026-09-16T22:00:00.000Z' }); // bad times ignored, date kept
  });
  it('finds the schedule in an image transcription when the post text has none', () => {
    expect(w('See the graphic', { imageText: 'Planned outage 20 September 2026 08:00-16:00' })).toEqual({ start: '2026-09-20T06:00:00.000Z', end: '2026-09-20T14:00:00.000Z' });
  });
});

describe('a planned window with the date in one place and the hours in another (Greenstone Hill)', () => {
  it('takes the date from the post text and the hours from the estimate', () => {
    const w = scheduleWindow({ result: { eta_text: '09h00 until 17h00' } }, 'planned power interruption which is scheduled to take place on Monday, 21 September 2026.', new Date('2026-09-20T06:00:00Z'));
    expect(w).toEqual({ start: '2026-09-21T07:00:00.000Z', end: '2026-09-21T15:00:00.000Z' });
  });
});

describe('a date range (Klipfontein: 22 and 23 September)', () => {
  const ref = new Date('2026-09-19T08:00:00Z');
  it('starts on the first day and ends on the last, at the daily hours', () => {
    expect(parseSchedule('rescheduled for Tuesday and Wednesday, 22 and 23 September 2026 from 09h00 until 17h00.', ref)).toMatchObject({ date: '2026-09-22', endDate: '2026-09-23', from: '09:00', to: '17:00' });
    expect(scheduleWindow(null, 'rescheduled for September 22-23, 2026, from 09h00 until 17h00.', ref)).toBeNull(); // month before the day is a format we do not read: no guess
    expect(scheduleWindow(null, 'rescheduled for 22 and 23 September 2026 from 09h00 until 17h00.', ref)).toEqual({ start: '2026-09-22T07:00:00.000Z', end: '2026-09-23T15:00:00.000Z' });
  });
  it('an ordinary single date is unchanged', () => {
    expect(parseSchedule('take place on 16 September 2026, from 09:00-17:00', ref)).toEqual({ date: '2026-09-16', from: '09:00', to: '17:00' });
  });
  it('an invalid range keeps the single last date', () => {
    expect(parseSchedule('planned for 31 and 32 September 2026', ref)?.endDate).toBeUndefined();
  });
});

describe('a weekly schedule graphic: each item takes its own day', () => {
  const image = 'City Power Weekly Maintenance Schedule for 21 September - 27 September 2026 The following maintenance interruptions is scheduled: Tuesday, 22 September • Randburg SDC - Beyers Substation from 09h00 until 17h00 affecting both BP Garages (North and South) along N1 Tuesday and Wednesday, 22 and 23 September 2026 • Midrand SDC - Klipfontein Substation from 09h00 until 17h00 affecting Klipfontein Wednesday, 23 September 2026 • Reuven SDC - Heriotdale Substation from 08h00 until 16h00 affecting Heriotdale • Lenasia SDC - Nancefield Substation from 09h00 until 17h00 affecting Johannesburg water Saturday, 26 September 2026 • Hursthill SDC - Mayfair Substation from 09h30 until 17h00 affecting Mayfair Sunday, 27 September 2026 • Alexandra SDC - Sebenza Substation from 09h00 until 17h00 affecting Greenstone Hill';
  const item = (name, eta) => ({ result: { image_text: image, eta_text: eta, entities: [{ type: 'SDC', name: 'Some SDC' }, { type: 'SUBSTATION', name }] } });
  const win = (name, eta) => scheduleWindow(item(name, eta), '', new Date('2026-09-21T06:00:00Z'));

  it('one day, a two-day range, and the last day of the week', () => {
    expect(win('Beyers', 'from 09h00 until 17h00')).toEqual({ start: '2026-09-22T07:00:00.000Z', end: '2026-09-22T15:00:00.000Z' });
    expect(win('Klipfontein', 'from 09h00 until 17h00')).toEqual({ start: '2026-09-22T07:00:00.000Z', end: '2026-09-23T15:00:00.000Z' });
    expect(win('Sebenza', 'from 09h00 until 17h00')).toEqual({ start: '2026-09-27T07:00:00.000Z', end: '2026-09-27T15:00:00.000Z' });
  });
  it('items under the same heading share its day, each with its own hours', () => {
    expect(win('Heriotdale', 'from 08h00 until 16h00')).toEqual({ start: '2026-09-23T06:00:00.000Z', end: '2026-09-23T14:00:00.000Z' });
    expect(win('Nancefield', 'from 09h00 until 17h00')).toEqual({ start: '2026-09-23T07:00:00.000Z', end: '2026-09-23T15:00:00.000Z' });
    expect(win('Mayfair', 'from 09h30 until 17h00')).toEqual({ start: '2026-09-26T07:30:00.000Z', end: '2026-09-26T15:00:00.000Z' });
  });
  it('takes the hours from the graphic when the item has none of its own', () => {
    expect(win('Heriotdale', null)).toEqual({ start: '2026-09-23T06:00:00.000Z', end: '2026-09-23T14:00:00.000Z' });
  });
  it('an item that is not in the graphic gets no window; post text is never overridden', () => {
    expect(win('Unknown Place', null)).toBeNull(); // no guess from the last date in the picture
    expect(scheduleWindow({ result: { image_text: image, entities: [{ type: 'SUBSTATION', name: 'Beyers' }] } }, 'On Monday, 28 September 2026 from 10:00-12:00', new Date('2026-09-21T06:00:00Z')).start).toBe('2026-09-28T08:00:00.000Z');
  });
});

describe('a summary picture whose planned item states its own date', () => {
  // The Lenasia picture of 21 Sept: an unrelated "yesterday, 20 September" sentence sits before the Nancefield item.
  const image = 'Lenasia SDC Outage Update 21 September 2026 15:50 ACTIVE OUTAGE: Ennerdale Substation, CBD 1 Feeder: Operators have been dispatched. The outage occurred yesterday, 20 September 2026, around 20h00. PLANNED MAINTENANCE: Nancefield Substation: This planned maintenance is scheduled to take place on Wednesday, 23 September 2026 from 09h00 until 17h00. Affecting Coca-Cola.';
  const item = { result: { image_text: image, eta_text: '23 September 2026 from 09h00 until 17h00', update_summary: 'Planned maintenance is scheduled at Nancefield Substation on Wednesday, 23 September 2026 from 09h00 until 17h00.', entities: [{ type: 'SDC', name: 'Lenasia' }, { type: 'SUBSTATION', name: 'Nancefield' }] } };

  it("takes the item's own date, not an unrelated date that happens to come before it", () => {
    expect(scheduleWindow(item, '', new Date('2026-09-21T13:00:00Z'))).toEqual({ start: '2026-09-23T07:00:00.000Z', end: '2026-09-23T15:00:00.000Z' });
  });
  it('an item with no date of its own still takes its heading in a weekly schedule', () => {
    const weekly = { result: { image_text: 'Tuesday, 22 September • Beyers Substation from 09h00 until 17h00 Wednesday, 23 September 2026 • Heriotdale Substation from 08h00 until 16h00', eta_text: 'from 08h00 until 16h00', update_summary: 'A planned power interruption is scheduled at Heriotdale Substation.', entities: [{ type: 'SUBSTATION', name: 'Heriotdale' }] } };
    expect(scheduleWindow(weekly, '', new Date('2026-09-21T06:00:00Z')).start).toBe('2026-09-23T06:00:00.000Z');
  });
});

describe('a daily summary picture: its header date is the issue date, not the date of the work', () => {
  const daily = 'Midrand SDC Outage Update 21 September 2026 14:50 PLANNED MAINTENANCE: Klipfontein Substation: planned interruption from 09h00 until 17h00 affecting Klipfontein.';
  const item = { result: { image_text: daily, eta_text: 'from 09h00 until 17h00', update_summary: 'A planned power interruption is scheduled at Klipfontein Substation from 09h00 until 17h00.', entities: [{ type: 'SUBSTATION', name: 'Klipfontein' }] } };
  it('gives no window at all (so it cannot overwrite the window the planned posts gave)', () => {
    expect(scheduleWindow(item, '', new Date('2026-09-21T13:00:00Z'))).toBeNull();
  });
});
