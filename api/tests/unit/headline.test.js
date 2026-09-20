import { describe, expect, it } from 'vitest';
import { headlineNode, pickHeadlineMatch } from '../../src/modules/outages/headline.js';

const nodes = [{ id: 'f', name: 'Fort', type: 'SUBSTATION' }, { id: 'c', name: 'Central', type: 'SUBSTATION' }, { id: 's', name: 'Inner City', type: 'SDC' }];

describe('headline of a summary picture', () => {
  it('is the equipment the post opens with', () => {
    expect(headlineNode('#CityPowerUpdates Fort Substation 98% restored as Central Substation repairs continue. https://t.co/x', nodes)?.id).toBe('f');
    expect(headlineNode('*Fort Substation:* the team will attend', nodes)?.id).toBe('f');
  });
  it('is nothing when the post opens with something else, or names the equipment only later', () => {
    expect(headlineNode('Repairs continue at Central Substation while Fort is 98% restored', nodes)).toBeNull();
    expect(headlineNode('Fortunately power is back', nodes)).toBeNull(); // "Fort" is not the word "Fortunately"
  });
  it('the longer name wins when two start the post', () => {
    expect(headlineNode('Fort Street Substation is back', [...nodes, { id: 'fs', name: 'Fort Street', type: 'SUBSTATION' }])?.id).toBe('fs');
  });
});

describe('accepting the rescored match', () => {
  it('needs a strong, clearly leading candidate', () => {
    expect(pickHeadlineMatch([{ score: 0.65 }, { score: 0.2 }])?.score).toBe(0.65);
    expect(pickHeadlineMatch([{ score: 0.55 }])).toBeNull();
    expect(pickHeadlineMatch([{ score: 0.7 }, { score: 0.62 }])).toBeNull();
    expect(pickHeadlineMatch([])).toBeNull();
  });
});
