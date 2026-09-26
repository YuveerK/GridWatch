import { describe, expect, it } from 'vitest';
import { geometryContains } from '../../src/lib/geo-contains.js';

const square = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };

describe('geometryContains', () => {
  it('includes a point inside a polygon and excludes a point outside', () => {
    expect(geometryContains(square, 1, 1)).toBe(true);
    expect(geometryContains(square, 3, 1)).toBe(false);
  });

  it('checks every part of a multipolygon', () => {
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]]] };
    expect(geometryContains(multi, 11, 11)).toBe(true);
    expect(geometryContains(multi, 5, 5)).toBe(false);
  });
});
