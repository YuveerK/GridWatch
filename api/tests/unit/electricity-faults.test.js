import { describe, expect, it } from 'vitest';
import { loadReductionFaults, mergeSameStationFaults } from '../../src/modules/ai/readers/electricity.reader.js';
import { faultItems } from '../../src/modules/processing/processor.service.js';

describe('planned load reduction', () => {
  const image = 'Planned Load Reduction- Pretoria East Wednesday, 30 September 2026 · 06:00 to 12:00 Villieria OFF Highlands OFF Mooikloof OFF';

  it('is one planned fault per substation, with the announced window (30 Sept)', () => {
    const result = {
      relevance: 'PLANNED_OUTAGE',
      image_text: image,
      entities: ['Villieria', 'Highlands', 'Mooikloof'].map((name) => ({ type: 'SUBSTATION', name })),
      faults: [],
      localities: [],
    };
    const faults = loadReductionFaults(result);
    expect(faults.map((f) => f.equipment[0].name)).toEqual(['Villieria', 'Highlands', 'Mooikloof']);
    expect(faults[0].summary).toMatch(/30 September 2026/);
    expect(faults[0].summary).toMatch(/06:00 to 12:00/);
    const items = faultItems({ relevance: 'PLANNED_OUTAGE', result });
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.fromDigest && item.extraction.relevance === 'PLANNED_OUTAGE')).toBe(true);
  });

  it('leaves an ordinary multi-station outage alone', () => {
    expect(loadReductionFaults({ image_text: 'Several substations are off', entities: [{ type: 'SUBSTATION', name: 'A' }, { type: 'SUBSTATION', name: 'B' }], faults: [] })).toBeNull();
  });
});

describe('two lines about one substation', () => {
  it('keeps an ongoing fault separate from later maintenance at the same station', () => {
    const equipment = [{ type: 'SUBSTATION', name: 'Gresswold' }];
    const faults = [
      { status: 'PARTIALLY_RESTORED', equipment, localities: [{ name: 'Lyndhurst' }], summary: '70% restored after the outage on 14 September 2026.' },
      { status: 'PLANNED', equipment, localities: [{ name: 'Bramley Park' }], summary: 'Maintenance on 17 September 2026 from 09:00 to 17:00.' },
    ];
    expect(mergeSameStationFaults(faults)).toEqual(faults);
  });

  it('only combines planned rows with the same schedule', () => {
    const fault = (day, from, name) => ({ status: 'PLANNED', equipment: [{ type: 'SUBSTATION', name: 'Mayfair' }], localities: [{ name }], summary: `Maintenance on ${day} September 2026 from ${from} to 17:00.` });
    const merged = mergeSameStationFaults([fault(26, '09:30', 'Mayfair'), fault(26, '09:30', 'Fordsburg'), fault(27, '09:30', 'Brixton'), fault(26, '12:00', 'Crosby')], { indexed: true });
    expect(merged.map((f) => f.sourceFaultIndex)).toEqual([0, 2, 3]);
    expect(merged[0].localities.map((l) => l.name)).toEqual(['Mayfair', 'Fordsburg']);
  });

  it('does not invent a separate window from a truncated table time', () => {
    const fault = (eta_text, summary = 'Maintenance') => ({ status: 'PLANNED', equipment: [{ type: 'SUBSTATION', name: 'Mayfair' }], localities: [], eta_text, summary });
    const merged = mergeSameStationFaults([fault('09:30-17:30'), fault('09:30-17:3'), fault('12:00-17:30')], { indexed: true });
    expect(merged.map((f) => f.sourceFaultIndex)).toEqual([0, 2]);
    const dates = mergeSameStationFaults([fault(null), fault(null, 'Maintenance on 26 September 2026'), fault(null, 'Maintenance on 27 September 2026')]);
    expect(dates).toHaveLength(2);
    expect(mergeSameStationFaults([fault(null, 'Maintenance on 26 September 2026'), fault(null, 'Maintenance on 26 and 27 September 2026')])).toHaveLength(2);
  });

  it('uses a sole detailed fault even when an UPDATE reading has empty top-level entities', () => {
    const items = faultItems({ relevance: 'UPDATE', result: { sdc: 'Roodepoort', entities: [], localities: [], faults: [{ status: 'REPAIRING', equipment: [{ type: 'SWITCHING_STATION', name: 'Liebenberg' }, { type: 'DISTRIBUTOR', name: 'David Street No.1', parent_name: 'Liebenberg' }], localities: [{ name: 'Constantia Kloof', state: 'AFFECTED' }] }] } });
    expect(items).toHaveLength(1);
    expect(items[0].extraction.result.entities.map((e) => e.name)).toContain('David Street No.1');
    expect(items[0].extraction.result.localities[0].name).toBe('Constantia Kloof');
  });
  it('keeps later source fault indices stable after merging duplicate station rows', () => {
    const fault = (name) => ({ status: 'PLANNED', equipment: [{ type: 'SUBSTATION', name }], localities: [], summary: 'Maintenance' });
    const items = faultItems({ relevance: 'PLANNED_OUTAGE', result: { faults: [fault('Mayfair'), fault('Mayfair'), fault('Sebenza')] } });
    expect(items.map((i) => [i.faultIndex, i.extraction.result.entities[0].name])).toEqual([[0, 'Mayfair'], [2, 'Sebenza']]);
  });

  it('are one fault (Alexandra theft and the isolation, 29 Sept)', () => {
    const faults = [
      { status: 'INVESTIGATING', equipment: [{ type: 'SUBSTATION', name: 'Alexandra' }], localities: [{ name: 'River Park' }], summary: 'Theft and vandalism.' },
      { status: 'INVESTIGATING', equipment: [{ type: 'SUBSTATION', name: 'Alexandra' }], localities: [{ name: 'Tsotsumani' }], summary: 'Emergency isolation.' },
      { status: 'REPAIRING', equipment: [{ type: 'SUBSTATION', name: 'Gresswold' }, { type: 'MINI_SUBSTATION', name: 'new mini-substation' }], localities: [{ name: 'Kew' }], summary: 'Mini-substation.' },
    ];
    const merged = mergeSameStationFaults(faults);
    expect(merged).toHaveLength(2);
    expect(merged[0].localities.map((l) => l.name)).toEqual(['River Park', 'Tsotsumani']);
    expect(merged[0].summary).toMatch(/Theft/);
    expect(merged[0].summary).toMatch(/isolation/);
    expect(merged[1].equipment).toHaveLength(2);
  });
});
