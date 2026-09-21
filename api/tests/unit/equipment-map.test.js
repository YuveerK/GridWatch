import { describe, expect, it, vi, afterEach } from 'vitest';
import { equipmentHubs, serviceCentrePlaces, weightedCentre, withoutOutliers } from '../../src/modules/geo/equipment-map.service.js';
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
