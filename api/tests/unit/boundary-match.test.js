import { describe, expect, it } from 'vitest';
import { combine, indexByName, matchBoundary, nameParts, planRepair, townshipKey } from '../../src/lib/boundary-match.js';
import { geometryContains, interiorPoint } from '../../src/lib/geo-contains.js';

const poly = (x) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] });
const feature = (name, x) => ({ properties: { name }, geometry: poly(x) });
const source = (label, features) => ({ label, index: indexByName(features, (f) => f.properties.name) });

describe('township names', () => {
  it('CoJ spelling and post spelling give the same key', () => {
    expect(townshipKey('BLOUBOSRAND EXT.13')).toBe(townshipKey('Bloubosrand Ext.13'));
    expect(townshipKey('JUKSKEI PARK')).toBe(townshipKey('Jukskei Park'));
  });

  it('"Lawley Ext 1 & 2" is two townships; ordinary names are one', () => {
    expect(nameParts('Lawley Ext 1 & 2')).toEqual(['lawley ext 1', 'lawley ext 2']);
    expect(nameParts('Bloubosrand Ext.13')).toEqual(['bloubosrand ext 13']);
    expect(nameParts('Rand and Mines')).toEqual(['rand and mines']);
  });
});

describe('matchBoundary', () => {
  const townships = source('coj-township', [feature('BLOUBOSRAND EXT.13', 0), feature('RIVERBEND A.H.', 2), feature('LAWLEY EXT.1', 4), feature('JUKSKEI PARK', 6), feature('JUKSKEI PARK', 6.01)]);
  const census = source('coj-census-2011', [feature('Lawley Ext 1', 10), feature('Lawley Ext 2', 12)]);
  const sources = [townships, census];

  it('an exact township name wins', () => {
    expect(matchBoundary('Bloubosrand Ext.13', sources)).toEqual({ boundary: poly(0), sources: ['coj-township'] });
  });

  it('a township split into several polygons comes back as one MultiPolygon', () => {
    expect(matchBoundary('Jukskei Park', sources).boundary).toEqual({ type: 'MultiPolygon', coordinates: [poly(6).coordinates, poly(6.01).coordinates] });
  });

  it('"Riverbend" finds the agricultural holdings "RIVERBEND A.H."', () => {
    expect(matchBoundary('Riverbend', sources)?.boundary).toEqual(poly(2));
  });

  it('a compound name takes each part from the best source that has it', () => {
    const m = matchBoundary('Lawley Ext 1 & 2', sources);
    expect(m.boundary.coordinates).toEqual([poly(4).coordinates, poly(12).coordinates]);
    expect(m.sources).toEqual(['coj-township', 'coj-census-2011']);
  });

  it('no outline when any part is missing, or the name is unknown (e.g. "Parktown West")', () => {
    expect(matchBoundary('Lawley Ext 1 & 3', sources)).toBeNull();
    expect(matchBoundary('Parktown West', sources)).toBeNull();
  });

  it('one name on two places far apart is ambiguous, so no outline is guessed', () => {
    const far = source('census', [feature('Freedom Park', 0), feature('Freedom Park', 0.5)]);
    expect(matchBoundary('Freedom Park', [far])).toBeNull();
  });

  it('a near name is not a match: "Jukskei" alone is not "Jukskei Park"', () => {
    expect(matchBoundary('Jukskei', sources)).toBeNull();
  });
});

describe('combine', () => {
  it('flattens polygons and multipolygons, and ignores anything else', () => {
    expect(combine([poly(0)])).toEqual(poly(0));
    expect(combine([{ type: 'Point', coordinates: [0, 0] }])).toBeNull();
    expect(combine([poly(0), { type: 'MultiPolygon', coordinates: [poly(2).coordinates] }]).coordinates).toHaveLength(2);
  });
});

describe('planRepair: a dot outside its own outline', () => {
  const square = (x, y, s = 0.01) => ({ type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });
  const pieces = { type: 'MultiPolygon', coordinates: [square(28.1, -26.0, 0.001).coordinates, square(28.105, -26.0, 0.001).coordinates] };

  it('nothing to do when the dot is inside', () => {
    expect(planRepair({ boundary: square(28, -26), lon: 28.005, lat: -25.995 }, null)).toEqual({ action: 'none' });
  });

  it('President Park: the stored outline is a few small extensions; the official A.H. outline holds the dot, so it is added and nothing is lost', () => {
    const ah = { boundary: square(28.09, -26.02, 0.03) };
    const plan = planRepair({ boundary: pieces, lon: 28.1, lat: -26.005 }, ah);
    expect(plan.action).toBe('outline');
    expect(plan.boundary.coordinates).toEqual([...pieces.coordinates, ah.boundary.coordinates]);
    expect(geometryContains(plan.boundary, 28.1, -26.005)).toBe(true);
  });

  it('North Riding: the official outline overlaps the stored one but holds the dot where the stored one does not; the result holds the dot', () => {
    const stored = square(28, -26, 0.02);
    const official = { boundary: square(28.01, -26, 0.015) }; // its middle is inside `stored`; the dot is not
    const [mx, my] = interiorPoint(official.boundary);
    expect(geometryContains(stored, mx, my)).toBe(true);
    const plan = planRepair({ boundary: stored, lon: 28.023, lat: -25.99 }, official);
    expect(plan.action).toBe('outline');
    expect(geometryContains(plan.boundary, 28.023, -25.99)).toBe(true);
  });

  it('an outline that already covers the official piece keeps its extensions and is not doubled', () => {
    const core = square(28, -26, 0.01);
    const withExtensions = { type: 'MultiPolygon', coordinates: [core.coordinates, square(28.02, -26, 0.01).coordinates] };
    const plan = planRepair({ boundary: withExtensions, lon: 28.5, lat: -26.5 }, { boundary: core });
    expect(plan.action).toBe('dot');
    expect(plan.boundary).toBe(withExtensions);
    expect(geometryContains(core, ...plan.point)).toBe(true);
  });

  it('Lawley: the dot is 32 km from the official outline, so the dot moves inside it', () => {
    const official = { boundary: square(27.8, -26.37) };
    const plan = planRepair({ boundary: official.boundary, lon: 27.98, lat: -26.17 }, official);
    expect(plan.action).toBe('dot');
    expect(geometryContains(official.boundary, ...plan.point)).toBe(true);
  });

  it('with no official outline to judge by, it does not guess', () => {
    expect(planRepair({ boundary: pieces, lon: 28, lat: -26 }, null)).toEqual({ action: 'unsure' });
  });
});

describe('interiorPoint', () => {
  it('lands inside a U-shaped suburb whose corner average is outside it', () => {
    const u = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]]] };
    const p = interiorPoint(u);
    expect(geometryContains(u, p[0], p[1])).toBe(true);
  });

  it('uses the largest piece of a MultiPolygon', () => {
    const big = [[[10, 10], [14, 10], [14, 14], [10, 14], [10, 10]]];
    const small = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
    const p = interiorPoint({ type: 'MultiPolygon', coordinates: [small, big] });
    expect(p[0]).toBeGreaterThan(10);
  });
});
