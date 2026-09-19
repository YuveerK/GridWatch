import { describe, expect, it } from 'vitest';
import { assignRegions, buildIndex, matchLocality, pointInPolygon } from '../../src/modules/geo/regions.service.js';

const square = (x, y, s = 1) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
const sub = (code, sp, mp, x, y) => ({ code, sp, mp, bbox: [x, y, x + 1, y + 1], center: [x + 0.5, y + 0.5], polygons: [square(x, y)] });
const loc = (id, name, extra = {}) => ({ id, canonicalName: name, normalizedName: name.toLowerCase(), lat: null, lon: null, ...extra });

const index = buildIndex([
  sub(1, 'Lenasia', 'Lenasia', 0, 0),
  sub(2, 'Lenasia Ext 3', 'Lenasia', 1, 0),
  sub(3, 'Roodepoort North', 'Roodepoort', 5, 5),
  sub(4, 'Roodepoort West', 'Roodepoort', 6, 5),
  sub(5, 'Honeydew Manor', 'Honeydew', 10, 10),
]);

describe('point in polygon', () => {
  it('respects the outline and any holes', () => {
    const ring = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
    const hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
    expect(pointInPolygon([0.5, 0.5], [ring, hole])).toBe(true);
    expect(pointInPolygon([2, 2], [ring, hole])).toBe(false); // inside the hole
    expect(pointInPolygon([9, 9], [ring, hole])).toBe(false);
  });
});

describe('matching a suburb to an outline', () => {
  it('uses the same name first', () => {
    expect(matchLocality(loc('a', 'Lenasia'), index)).toMatchObject({ kind: 'exact', subs: [{ code: 1 }] });
  });
  it('matches the extension outline when City Power names the extension', () => {
    expect(matchLocality(loc('a', 'Lenasia Extension 3', { normalizedName: 'lenasia ext 3' }), index)).toMatchObject({ kind: 'exact', subs: [{ code: 2 }] });
  });
  it('uses the whole main place for a bigger area like Roodepoort', () => {
    const m = matchLocality(loc('a', 'Roodepoort'), index);
    expect(m.kind).toBe('main');
    expect(m.subs.map((s) => s.code)).toEqual([3, 4]);
  });
  it('falls back to the outline the map pin sits in, and says so', () => {
    expect(matchLocality(loc('a', 'Honeydew Village', { lat: 10.5, lon: 10.5 }), index)).toMatchObject({ kind: 'near', subs: [{ code: 5 }] });
  });
  it('finds nothing when there is no name match and no pin', () => {
    expect(matchLocality(loc('a', 'Nowhere Park'), index)).toBeNull();
  });
});

describe('assigning outlines', () => {
  it('never draws one outline twice: an exact name beats "the pin falls in it"', () => {
    const features = assignRegions([loc('near', 'Somewhere Else', { lat: 0.5, lon: 0.5 }), loc('exact', 'Lenasia')], index);
    expect(features.map((f) => f.properties.id)).toEqual(['exact']);
  });
});
