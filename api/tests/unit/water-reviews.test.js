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

  it('towers named together without a water system become one fault each (Roodepoort, 27 Sept)', () => {
    const items = waterFaultItems({
      relevance: 'UPDATE',
      result: {
        relevance: 'UPDATE',
        faults: [
          {
            water_state: 'RECOVERING',
            cause: 'Eikenhof challenges',
            summary: 'Roodepoort towers recovering',
            entities: [entity('Waterval Tower', 'WATER_TOWER'), entity('Querellina Tower', 'WATER_TOWER'), entity('Florida North Tower', 'WATER_TOWER')],
            localities: [],
            systems: ['Roodepoort'],
          },
          {
            water_state: 'RECOVERING',
            cause: 'Eikenhof challenges',
            summary: 'Commando still recovering',
            entities: [entity('Commando System', 'WATER_SYSTEM'), entity('Crosby Pump Station', 'PUMP_STATION'), entity('Brixton Reservoir', 'RESERVOIR')],
            localities: [],
            systems: ['Commando'],
          },
        ],
      },
    });
    expect(items.map((item) => item.extraction.result.entities.map((asset) => asset.name))).toEqual([
      ['Waterval Tower'],
      ['Querellina Tower'],
      ['Florida North Tower'],
      ['Commando System', 'Crosby Pump Station', 'Brixton Reservoir'],
    ]);
  });

  it('a stable system line with no asset is a notice (Randburg and Roodepoort, 28 Sept)', () => {
    const items = waterFaultItems({
      relevance: 'OUTAGE',
      result: {
        relevance: 'OUTAGE',
        water_state: 'RECOVERING',
        cause: 'unplanned power outage impacting Rand Water Eikenhof system',
        entities: [],
        localities: [],
        faults: [
          {
            water_state: 'RECOVERING',
            cause: 'unplanned power outage impacting Rand Water Eikenhof system',
            summary: 'Honeydew Reservoir and Tower declined to critically low.',
            entities: [entity('Quellerina Tower', 'WATER_TOWER')],
            localities: [],
            systems: ['Randburg'],
          },
          {
            water_state: 'STABLE',
            cause: 'unplanned power outage impacting Rand Water Eikenhof system',
            summary: 'Roodepoort systems remain stable and supplying fairly to adequately.',
            entities: [],
            localities: [],
            systems: ['Roodepoort'],
          },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items[1].extraction.relevance).toBe('GENERAL_NOTICE');
    expect(items[0].extraction.relevance).not.toBe('GENERAL_NOTICE');
  });

  it('keeps a reservoir and its tower together (Crown Gardens, 27 Sept)', () => {
    const items = waterFaultItems({
      relevance: 'UPDATE',
      result: {
        relevance: 'UPDATE',
        faults: [
          {
            water_state: 'LOW',
            cause: null,
            summary: 'Crown Gardens',
            entities: [entity('Crown Gardens Reservoir', 'RESERVOIR'), entity('Crown Gardens Tower', 'WATER_TOWER')],
            localities: [],
            systems: [],
          },
        ],
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0].fromDigest).toBe(false);
    expect(items[0].extraction.result.faults[0].entities.map((asset) => asset.name)).toEqual(['Crown Gardens Reservoir', 'Crown Gardens Tower']);
  });

  it('the golden review file records three faults for each Commando notice and none for Midrand', () => {
    const cases = JSON.parse(readFileSync(new URL('../golden/water-reviews.json', import.meta.url), 'utf8'));
    expect(cases.find((c) => c.externalId === '2098125777971671387').faults).toHaveLength(3);
    expect(cases.find((c) => c.externalId === '2099487089465172357').faults).toHaveLength(3);
    expect(cases.find((c) => c.externalId === '2100212024043024579').decision).toBe('IGNORED');
  });
});
