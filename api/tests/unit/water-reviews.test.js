import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { waterFaultItems } from '../../src/modules/ai/readers/water.reader.js';

const entity = (name, type) => ({ name, type, operator: 'JOHANNESBURG_WATER', parent_name: null, relationType: null });

const commando = {
  relevance: 'OUTAGE',
  water_state: 'CONSTRAINED',
  customer_supply: null,
  cause: 'bulk supply constrained',
  entities: [],
  localities: [],
  faults: [
    { water_state: 'LOW', cause: 'low but supplying', eta_text: null, summary: 'Crosby', entities: [entity('Crosby Reservoir', 'RESERVOIR')], localities: [], systems: [] },
    { water_state: 'RECOVERING', cause: 'outlets open', eta_text: null, summary: 'Brixton', entities: [entity('Brixton 1', 'RESERVOIR')], localities: [], systems: [] },
    { water_state: 'BYPASS', cause: 'on bypass', eta_text: null, summary: 'Hursthill', entities: [entity('Hursthill 1', 'RESERVOIR')], localities: [], systems: [] },
  ],
};

describe('water review fixtures', () => {
  it('splits a Commando status into one fault per distinct operating state', () => {
    const items = waterFaultItems({ relevance: 'OUTAGE', result: commando });
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.extraction.result.water_state)).toEqual(['LOW', 'RECOVERING', 'BYPASS']);
    expect(items.every((item) => item.fromDigest)).toBe(true);
    expect(items.map((item) => item.extraction.result.entities[0].name)).toEqual(['Crosby Reservoir', 'Brixton 1', 'Hursthill 1']);
  });

  it('the golden review file records three faults for each Commando notice and none for Midrand', () => {
    const cases = JSON.parse(readFileSync(new URL('../golden/water-reviews.json', import.meta.url), 'utf8'));
    expect(cases.find((c) => c.externalId === '2098125777971671387').faults).toHaveLength(3);
    expect(cases.find((c) => c.externalId === '2099487089465172357').faults).toHaveLength(3);
    expect(cases.find((c) => c.externalId === '2100212024043024579').decision).toBe('IGNORED');
  });
});
