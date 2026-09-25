import { describe, expect, it, vi, afterEach } from 'vitest';
import { equipmentHubs, placeWaterHub, serviceCentrePlaces, supplyView, weightedCentre, withoutOutliers } from '../../src/modules/geo/equipment-map.service.js';
import { prisma } from '../../src/db/prisma.js';

afterEach(() => vi.restoreAllMocks());

describe('service centre coverage', () => {
  it('collects nested suburbs once, combines evidence and tolerates cycles', () => {
    const suburb = { id: 'a', lon: 28, lat: -26, w: 2 };
    const nodes = new Map([
      ['sdc', { pts: [suburb] }],
      ['sub', { pts: [suburb] }],
      ['distributor', { pts: [{ id: 'b', lon: 28.1, lat: -26.1, w: 1 }] }],
      ['other', { pts: [{ id: 'unrelated', lon: 29, lat: -27, w: 1 }] }],
    ]);
    const edges = [{ parentId: 'sdc', childId: 'sub' }, { parentId: 'sub', childId: 'distributor' }, { parentId: 'distributor', childId: 'sdc' }];
    expect(serviceCentrePlaces('sdc', nodes, edges)).toEqual([{ ...suburb, w: 4 }, nodes.get('distributor').pts[0]]);
    expect(nodes.get('sdc').pts[0].w).toBe(2);
  });

  it('includes a centre with only downstream geography and uses SDC outage names', async () => {
    vi.spyOn(prisma.nodeLocality, 'findMany').mockResolvedValue([
      { nodeId: 'sub', evidenceCount: 2, locality: { id: 'a', lat: -26, lon: 28 }, node: { id: 'sub', name: 'Substation', type: 'SUBSTATION' } },
    ]);
    vi.spyOn(prisma.infraEdge, 'findMany').mockResolvedValue([{ parentId: 'sdc', childId: 'sub' }]);
    vi.spyOn(prisma.infraNode, 'findMany').mockResolvedValue([
      { id: 'sdc', name: 'Randburg', type: 'SDC' },
      { id: 'empty', name: 'Unmapped', type: 'SDC' },
    ]);
    vi.spyOn(prisma.outageNode, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.outage, 'findMany').mockResolvedValue([{ sdcName: 'Randburg' }]);
    const hubs = await equipmentHubs();
    expect(hubs.find((h) => h.id === 'sdc')).toMatchObject({ type: 'SDC', lon: 28, lat: -26, served: 1, live: true });
    expect(hubs.find((h) => h.id === 'sub')).toMatchObject({ served: 1, parentId: 'sdc', live: false });
    expect(hubs.some((h) => h.id === 'empty')).toBe(false);
  });
});

describe('equipment position', () => {
  it('sits at the evidence-weighted centre of the suburbs it serves', () => {
    const c = weightedCentre([{ lon: 28, lat: -26, w: 3 }, { lon: 29, lat: -27, w: 1 }]);
    expect(c[0]).toBeCloseTo(28.25);
    expect(c[1]).toBeCloseTo(-26.25);
    expect(weightedCentre([])).toBeNull();
  });

  it('places a water asset on the suburbs it supplies when the asset itself has no coordinates', () => {
    const placed = placeWaterHub({
      id: 'res', name: 'Aeroton Reservoir', type: 'RESERVOIR', lat: null, lon: null,
      localities: [{ evidenceCount: 2, locality: { lat: -26.2, lon: 28.0 } }, { evidenceCount: 2, locality: { lat: -26.4, lon: 28.2 } }],
    }, true);
    expect(placed).toMatchObject({ id: 'res', type: 'RESERVOIR', served: 2, live: true, derived: true });
    expect(placed.lon).toBeCloseTo(28.1);
    expect(placed.lat).toBeCloseTo(-26.3);
    expect(placeWaterHub({ id: 'bare', name: 'Bare', type: 'RESERVOIR', lat: null, lon: null, localities: [] })).toBeNull();
  });

  it('returns power and water assets that can be drawn for one suburb', () => {
    const points = new Map([['sub', [{ lon: 28, lat: -26, w: 1 }]]]);
    const view = supplyView(
      { id: 'fourways', canonicalName: 'Fourways', lat: -26.02, lon: 28.01, boundary: { type: 'Polygon' } },
      [
        { evidenceCount: 3, node: { id: 'sub', name: 'Fourways substation', type: 'SUBSTATION', serviceType: 'ELECTRICITY', lat: null, lon: null } },
        { evidenceCount: 2, node: { id: 'res', name: 'Douglasdale Reservoir', type: 'RESERVOIR', serviceType: 'WATER', lat: -26.05, lon: 28.03 } },
        { evidenceCount: 9, node: { id: 'sdc', name: 'Randburg', type: 'SDC', serviceType: 'ELECTRICITY', lat: -26, lon: 28 } },
      ],
      points,
      new Set(['res']),
    );
    expect(view.locality).toMatchObject({ name: 'Fourways', boundary: { type: 'Polygon' } });
    expect(view.assets.map((asset) => asset.id)).toEqual(['sub', 'res']);
    expect(view.assets[0]).toMatchObject({ service: 'ELECTRICITY', lon: 28, lat: -26 });
    expect(view.assets[1]).toMatchObject({ service: 'WATER', live: true, lat: -26.05 });
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
