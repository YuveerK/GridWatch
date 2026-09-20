import { describe, expect, it } from 'vitest';
import { distanceKm, isPlausible } from '../../src/modules/geo/plausible.js';

// a region of ten suburbs around Roodepoort
const region = Array.from({ length: 10 }, (_, i) => ({ lat: -26.11 + (i % 3) * 0.02, lon: 27.88 + (i % 4) * 0.02 }));

describe('is a position believable for a suburb of this region?', () => {
  it('measures distance in kilometres', () => {
    expect(distanceKm({ lat: -26.0978, lon: 27.8763 }, { lat: -26.1032, lon: 28.0657 })).toBeGreaterThan(18); // the two Willowbrooks
    expect(distanceKm({ lat: -26, lon: 28 }, { lat: -26, lon: 28 })).toBe(0);
  });
  it('accepts a position inside the region', () => {
    expect(isPlausible({ lat: -26.098, lon: 27.876 }, region)).toBe(true);
  });
  it('rejects the same name found 18 km away in another part of the city', () => {
    expect(isPlausible({ lat: -26.1032, lon: 28.0657 }, region)).toBe(false);
  });
  it('accepts an outlying suburb when another suburb of the region is right next to it', () => {
    const edge = [...region, { lat: -26.2, lon: 27.75 }];
    expect(isPlausible({ lat: -26.201, lon: 27.752 }, edge)).toBe(true);
  });
  it('never rejects when the region is still unknown (too few placed suburbs)', () => {
    expect(isPlausible({ lat: -26.1, lon: 28.5 }, region.slice(0, 3))).toBe(true);
    expect(isPlausible({ lat: -26.1, lon: 28.5 }, undefined)).toBe(true);
  });
});
