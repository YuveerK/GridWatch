import { describe, expect, it } from 'vitest';
import { classify } from '../../src/modules/api/updates.service.js';

describe('which posts are news', () => {
  it('a new outage and a restoration are always news', () => {
    expect(classify({ role: 'OPENED', effect: {}, prev: null })).toBe('opened');
    expect(classify({ role: 'RESTORATION', effect: { status: 'RESTORED' }, prev: { status: 'ACTIVE' } })).toBe('restored');
  });
  it('progress, a changed estimate and a changed status are news', () => {
    const prev = { status: 'INVESTIGATING', pct: 20, eta: 'ETA 3pm' };
    expect(classify({ role: 'UPDATE', effect: { status: 'INVESTIGATING', pct: 48, eta: 'ETA 3pm' }, prev })).toBe('progress');
    expect(classify({ role: 'UPDATE', effect: { status: 'INVESTIGATING', pct: 20, eta: 'ETA 6pm' }, prev })).toBe('estimate');
    expect(classify({ role: 'UPDATE', effect: { status: 'REPAIRING', pct: 20, eta: 'ETA 3pm' }, prev })).toBe('status');
    expect(classify({ role: 'UPDATE', effect: { status: 'PARTIALLY_RESTORED', pct: 20, eta: 'ETA 3pm' }, prev })).toBe('progress');
  });
  it('a follow-up that repeats the same status still shows', () => {
    const same = { status: 'REPAIRING', pct: null, eta: 'ETA 3pm' };
    expect(classify({ role: 'UPDATE', effect: same, prev: same })).toBe('update');
  });
  it('the first update in view still shows when it names no percentage or estimate', () => {
    expect(classify({ role: 'UPDATE', effect: { status: 'INVESTIGATING', pct: null, eta: null }, prev: null })).toBe('update');
    expect(classify({ role: 'UPDATE', effect: { status: 'INVESTIGATING', pct: null, eta: 'ETA 3pm' }, prev: null })).toBe('estimate');
    expect(classify({ role: 'UPDATE', effect: null, prev: null })).toBe('update');
  });
});

import { readingEffect } from '../../src/modules/api/updates.service.js';

describe('reading an old post', () => {
  it('takes status, percentage and estimate from the stored reading', () => {
    expect(readingEffect({ status: 'REPAIRING', restoration_percent: 48, eta_text: 'ETA 3pm', faults: [] })).toEqual({ status: 'REPAIRING', pct: 48, eta: 'ETA 3pm' });
  });
  it('for a graphic with several faults, uses that fault', () => {
    const result = { status: 'UNKNOWN', faults: [{ status: 'INVESTIGATING', restoration_percent: null, eta_text: null }, { status: 'PARTIALLY_RESTORED', restoration_percent: 60, eta_text: null }] };
    expect(readingEffect(result, 1)).toEqual({ status: 'PARTIALLY_RESTORED', pct: 60, eta: null });
    expect(readingEffect(result, 5)).toBeNull();
  });
  it('no reading means nothing to compare', () => {
    expect(readingEffect(null)).toBeNull();
  });
});
