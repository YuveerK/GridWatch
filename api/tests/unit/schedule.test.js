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
