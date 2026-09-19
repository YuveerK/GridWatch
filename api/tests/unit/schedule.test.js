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
