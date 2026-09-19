import { describe, expect, it } from 'vitest';
import { weightedCentre, withoutOutliers } from '../../src/modules/geo/equipment-map.service.js';

describe('equipment position', () => {
  it('sits at the evidence-weighted centre of the suburbs it serves', () => {
    const c = weightedCentre([{ lon: 28, lat: -26, w: 3 }, { lon: 29, lat: -27, w: 1 }]);
    expect(c[0]).toBeCloseTo(28.25);
    expect(c[1]).toBeCloseTo(-26.25);
    expect(weightedCentre([])).toBeNull();
  });
});

describe('drawing connections', () => {
  const near = (i) => ({ id: 'n' + i, lon: 28 + i * 0.01, lat: -26 + i * 0.01 });
  it('drops a suburb across the city that one old graphic tied to the equipment', () => {
    const places = [near(0), near(1), near(2), near(3), { id: 'far', lon: 28.1, lat: -26.6 }];
    const kept = withoutOutliers(places, [28.01, -26.01]).map((p) => p.id);
    expect(kept).not.toContain('far');
    expect(kept).toHaveLength(4);
  });
  it('keeps everything when there are too few to judge', () => {
    const places = [near(0), { id: 'far', lon: 28.5, lat: -26.5 }];
    expect(withoutOutliers(places, [28, -26])).toHaveLength(2);
  });
});
