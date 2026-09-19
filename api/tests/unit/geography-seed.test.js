import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collisions, parseGeographyText } from '../../src/lib/geography-seed.js';

describe('geography seed parser (A17)', () => {
  const sample = 'Region A Subrubs\nAirdlin,\n\nBarbeque, Barbeque Downs, Beverley Ext.1 & 2, Kyalami Hills. Kyalami Park,\n\nRegion E\nWARD LOCATION\n32 Linbro Park, Greenstone,\nSunningdale Ext 1,2,3, Sunningdale\n';
  const regions = parseGeographyText(sample);
  it('reads regions, one suburb per name, ignoring ward numbers, stray digits and duplicates', () => {
    expect(regions.map((r) => r.code)).toEqual(['A', 'E']);
    expect(regions[0].localities.map((l) => l.name)).toEqual(['Airdlin', 'Barbeque', 'Barbeque Downs', 'Beverley Ext.1 & 2', 'Kyalami Hills', 'Kyalami Park']);
    expect(regions[1].localities.map((l) => l.name)).toEqual(['Linbro Park', 'Greenstone', 'Sunningdale Ext 1', 'Sunningdale']);
  });
  it('records the source line and finds names that sit in two regions', () => {
    expect(regions[0].localities[0].sourceLine).toBe(2);
    expect(collisions(parseGeographyText('Region A\nBellevue\nRegion B\nBellevue, Other\n'))).toEqual([{ name: 'bellevue', regions: ['A', 'B'] }]);
  });
  it('parses the supplied file into seven regions with a plausible number of suburbs', () => {
    const all = parseGeographyText(readFileSync(new URL('../../data/johannesburg.txt', import.meta.url), 'utf8'));
    expect(all.map((r) => r.code)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(all.reduce((n, r) => n + r.localities.length, 0)).toBeGreaterThan(1000);
    expect(all[0].localities.some((l) => l.name === 'Dainfern')).toBe(true);
  });
});
