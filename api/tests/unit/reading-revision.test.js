import { describe, expect, it } from 'vitest';
import { readingRevision } from '../../src/lib/reading-revision.js';

const base = () => ({
  relevance: 'UPDATE', status: 'REPAIRING', sdc: 'Inner City', cause: 'cable fault', eta_text: null, restoration_percent: null,
  entities: [{ type: 'SUBSTATION', name: 'Fort', parent_name: null }], localities: [{ name: 'Hillbrow', state: 'AFFECTED' }], faults: [],
  update_summary: 'Repairs continue', image_text: 'a picture', __reading: { model: 'x' },
});

describe('E10: which reading an effect came from', () => {
  it('is the same for the same reading, whatever the wording, the transcription or the stamp', () => {
    const a = readingRevision(base());
    expect(readingRevision({ ...base(), update_summary: 'Different words', image_text: 'other text', __reading: { model: 'y' } })).toBe(a);
    expect(readingRevision({ ...base(), entities: [...base().entities].reverse(), cause: '  Cable   FAULT ' })).toBe(a);
  });
  it.each([
    ['status', { status: 'PARTIALLY_RESTORED' }],
    ['percentage', { restoration_percent: 75 }],
    ['cause', { cause: 'vandalism' }],
    ['estimate', { eta_text: 'Tonight at 20h00' }],
    ['a suburb state', { localities: [{ name: 'Hillbrow', state: 'RESTORED' }] }],
    ['a suburb', { localities: [{ name: 'Berea', state: 'AFFECTED' }] }],
    ['the equipment', { entities: [{ type: 'SUBSTATION', name: 'Central', parent_name: null }] }],
    ['the classification', { relevance: 'RESTORATION' }],
  ])('changes when %s changes, even though the fault count and layout do not', (_what, change) => {
    expect(readingRevision({ ...base(), ...change })).not.toBe(readingRevision(base()));
  });
  it('a fault of a graphic changing is noticed, and so is a fault being added', () => {
    const f = (status) => ({ status, restoration_percent: null, cause: null, eta_text: null, equipment: [], localities: [] });
    const a = readingRevision({ ...base(), faults: [f('REPAIRING'), f('PLANNED')] });
    expect(readingRevision({ ...base(), faults: [f('REPAIRING'), f('RESTORED')] })).not.toBe(a);
    expect(readingRevision({ ...base(), faults: [f('REPAIRING')] })).not.toBe(a);
  });
  it('is null when there is no reading', () => {
    expect(readingRevision(null)).toBeNull();
  });
});
