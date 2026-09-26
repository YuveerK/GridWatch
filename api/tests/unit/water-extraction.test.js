import { describe, expect, it } from 'vitest';
import { classifyWaterNotice, isUnsplitWaterBoard, waterNoticeSummary, waterReader } from '../../src/modules/ai/readers/water.reader.js';
import { WATER_PROMPT_VERSION } from '../../src/modules/ai/prompts/water.prompt.js';
import { prepareWaterReading, waterExtractionJsonSchema, waterExtractionSchema } from '../../src/modules/ai/schemas/water-extraction.schema.js';

const base = {
  relevance: 'INTERRUPTION',
  kind: 'UNPLANNED',
  water_state: 'NO_SUPPLY',
  customer_supply: null,
  cause: null,
  eta_text: null,
  restoration_percent: null,
  systems: [],
  entities: [],
  localities: [],
  faults: [],
  image_text: '',
  confidence: 0.9,
  review_reason: null,
};

describe('water extraction contract', () => {
  it('uses a new prompt version and the same enums in the Gemini schema', () => {
    expect(WATER_PROMPT_VERSION).toBe('water-2');
    expect(waterReader.promptVersion).toBe('water-2');
    const entity = waterExtractionJsonSchema.properties.entities.items;
    expect(entity.properties.type.enum).toContain('RESERVOIR');
    expect(entity.properties.operator.anyOf?.some((part) => part.enum?.includes('JOHANNESBURG_WATER')) ?? entity.properties.operator.enum).toBeTruthy();
    const faultEntity = waterExtractionJsonSchema.properties.faults.items.properties.entities.items;
    expect(faultEntity.properties.name.type).toBe('string');
    expect(faultEntity.properties.type.enum).toContain('RESERVOIR');
  });

  it('parses a known operator and leaves an unknown parent null', () => {
    const parsed = waterReader.parse({
      ...base,
      entities: [{ name: 'Honeydew Reservoir', type: 'RESERVOIR', operator: 'JOHANNESBURG_WATER', parent_name: null, relationType: null }],
    });
    expect(parsed.entities[0].parent_name).toBeNull();
    expect(parsed.entities[0].relationType).toBeNull();
  });

  it('canonicalises the Johannesburg Water label and rejects an unknown operator', () => {
    const parsed = waterReader.parse({
      ...base,
      entities: [{ name: 'Honeydew Reservoir', type: 'RESERVOIR', operator: 'Johannesburg Water', parent_name: null, relationType: null }],
    });
    expect(parsed.entities[0].operator).toBe('JOHANNESBURG_WATER');
    expect(() => waterExtractionSchema.parse(prepareWaterReading({
      ...base,
      entities: [{ name: 'Honeydew Reservoir', type: 'RESERVOIR', operator: 'Some other utility', parent_name: null, relationType: null }],
    }))).toThrow(/JOHANNESBURG_WATER/);
  });

  it('drops empty fault placeholders and keeps a real empty list', () => {
    const parsed = waterReader.parse({
      ...base,
      faults: [{ water_state: 'LOW_PRESSURE', cause: null, eta_text: null, restoration_percent: null, summary: null, entities: [{}], localities: [{}], systems: [] }],
    });
    expect(parsed.faults[0].entities).toEqual([]);
    expect(parsed.faults[0].localities).toEqual([]);
    expect(waterReader.parse({ ...base, entities: [], localities: [] }).entities).toEqual([]);
  });

  it('derives suburb state from impact', () => {
    for (const impact of ['NO_SUPPLY', 'LOW_PRESSURE', 'AFFECTED', 'UNKNOWN']) {
      const reading = waterReader.normaliseReading(waterReader.parse({ ...base, localities: [{ name: 'Zondi', impact }] }));
      expect(reading.localities[0].state).toBe('AFFECTED');
    }
    const restored = waterReader.normaliseReading(waterReader.parse({ ...base, localities: [{ name: 'Zondi', impact: 'RESTORED' }] }));
    expect(restored.localities[0].state).toBe('RESTORED');
    const faulted = waterReader.normaliseReading(waterReader.parse({
      ...base,
      faults: [{ water_state: 'NO_SUPPLY', cause: null, eta_text: null, restoration_percent: null, summary: null, entities: [], localities: [{ name: 'Naledi', impact: 'NO_SUPPLY' }], systems: [] }],
    }));
    expect(faulted.faults[0].localities[0].state).toBe('AFFECTED');
  });
});

describe('a water system-status board', () => {
  const asset = (name) => ({ type: 'RESERVOIR', name, parent_name: null });
  // a status LIST (the parser could not read its layout); a written notice naming as many assets is one event instead
  const list = 'Illovo Supplying adequately. Bryanston Supplying adequately. Morningside Supplying fairly. Linksfield On bypass.';
  it('does not treat many independently listed assets as one incident', () => {
    expect(isUnsplitWaterBoard({
      image_text: list,
      entities: ['Illovo', 'Bryanston', 'Morningside', 'Linksfield'].map(asset),
      localities: [],
      faults: [],
    })).toBe(true);
  });
  it('keeps one reservoir and its named supply zone as one incident', () => {
    expect(isUnsplitWaterBoard({
      entities: [asset('Olivedale Reservoir')],
      localities: Array.from({ length: 25 }, (_, i) => ({ name: `Suburb ${i}` })),
      faults: [],
    })).toBe(false);
  });
  it('still sees a board when every asset is only listed under the system heading', () => {
    expect(isUnsplitWaterBoard({
      image_text: `Sandton System ${list}`,
      entities: [
        { type: 'WATER_SYSTEM', name: 'Sandton System', parent_name: null },
        ...['Illovo', 'Bryanston', 'Linksfield'].map((name) => ({ type: 'RESERVOIR', name, parent_name: 'Sandton System' })),
      ],
      localities: [],
      faults: [],
    })).toBe(true);
  });
  it('keeps an upstream asset that the notice says feeds the others', () => {
    expect(isUnsplitWaterBoard({
      entities: [asset('Rand Water'), { type: 'RESERVOIR', name: 'A', parent_name: 'Rand Water' }, { type: 'RESERVOIR', name: 'B', parent_name: 'Rand Water' }],
      localities: [],
      faults: [],
    })).toBe(false);
  });
describe('water notices that are not incidents', () => {
  const empty = { ...base, entities: [], localities: [], faults: [], cause: null, customer_supply: null, water_state: 'UNKNOWN' };

  it('treats a trivia question as irrelevant', () => {
    const reading = waterReader.normaliseReading({ ...empty, relevance: 'INFORMATIONAL', confidence: 0.2, review_reason: 'Notice is a trivia question rather than an operational notice.' });
    expect(reading.relevance).toBe('IRRELEVANT');
    expect(classifyWaterNotice(reading)).toBe('IRRELEVANT');
  });

  it('treats a promotional community post as irrelevant', () => {
    expect(classifyWaterNotice({ ...empty, relevance: 'INFORMATIONAL', review_reason: 'promotional community post about saving water' })).toBe('IRRELEVANT');
  });

  it('treats a link-only operational headline as a general notice', () => {
    const reading = waterReader.normaliseReading({ ...empty, relevance: 'INFORMATIONAL', confidence: 0.3, review_reason: 'Notice contains only a system update link without specific operational details or impacts.', image_text: 'Central Systems Update' });
    expect(reading.relevance).toBe('GENERAL_NOTICE');
  });

  it('leaves a low-confidence outage for a person', () => {
    expect(classifyWaterNotice({ ...empty, relevance: 'OUTAGE', water_state: 'NO_SUPPLY', localities: [{ name: 'Soweto', impact: 'NO_SUPPLY' }], confidence: 0.4, review_reason: 'cannot tell which reservoir failed' })).toBeNull();
  });
});

describe('water notice summaries', () => {
  const place = {
    entities: [{ type: 'PRV', name: 'Jangroentjie Avenue PRV', operator: 'JOHANNESBURG_WATER', parent_name: null, relationType: null }],
    localities: [{ name: 'Randpark Ridge', impact: 'RESTORED' }],
    faults: [],
    cause: null,
  };

  it('writes a restoration sentence when supply is restored and cause is empty', () => {
    const reading = waterReader.normaliseReading({ ...base, ...place, relevance: 'RESTORATION', water_state: 'RECOVERING', customer_supply: 'RESTORED' });
    expect(reading.update_summary).toMatch(/restored/i);
    expect(reading.update_summary).toMatch(/Jangroentjie Avenue PRV/);
    expect(reading.update_summary).toMatch(/Randpark Ridge/);
    expect(reading.update_summary.length).toBeGreaterThanOrEqual(25);
  });

  it('keeps a recovery notice from claiming customers have water', () => {
    const summary = waterNoticeSummary({ ...base, water_state: 'RECOVERING', customer_supply: null, entities: [{ name: 'Hurlingham Reservoir' }], localities: [{ name: 'Hurlingham', impact: 'AFFECTED' }] });
    expect(summary).toMatch(/recovering/i);
    expect(summary).not.toMatch(/restored/i);
  });

  it('summarises an outage and keeps a written update sentence', () => {
    expect(waterNoticeSummary({ ...base, water_state: 'NO_SUPPLY', entities: [{ name: 'Honeydew Reservoir' }], localities: [{ name: 'Willowbrook', impact: 'NO_SUPPLY' }] })).toMatch(/no water supply/i);
    const written = 'Crews are repairing the valve and supply remains interrupted in the area.';
    expect(waterNoticeSummary({ ...base, relevance: 'SYSTEM_UPDATE', water_state: 'LOW', cause: written })).toBe(written);
  });
});

  it('leaves a board the reader already split into faults', () => {
    expect(isUnsplitWaterBoard({
      entities: ['Illovo', 'Bryanston', 'Linksfield'].map(asset),
      localities: [],
      faults: [{}, {}],
    })).toBe(false);
  });
});
