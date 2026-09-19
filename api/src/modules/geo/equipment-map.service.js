import { prisma } from '../../db/prisma.js';

// Where City Power's equipment "is" on the map. City Power publishes no coordinates for it, so a piece of equipment is
// drawn at the centre of the suburbs it is known to serve (weighted by how often posts tied them together).
// That is an inference, and the map says so. The connections (which suburbs it feeds) are real, learned from City Power's own posts.

const HUB_TYPES = ['SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR'];
const LIVE = ['ACTIVE', 'PARTIALLY_RESTORED'];

/** Evidence-weighted centre of some suburbs: [{ lat, lon, w }] -> [lon, lat] or null. */
export function weightedCentre(points) {
  const total = points.reduce((s, p) => s + p.w, 0);
  if (!total) return null;
  return [points.reduce((s, p) => s + p.lon * p.w, 0) / total, points.reduce((s, p) => s + p.lat * p.w, 0) / total];
}

const km = (a, b) => Math.hypot((a[0] - b[0]) * 99.7, (a[1] - b[1]) * 111); // good enough around Johannesburg

/**
 * Drop suburbs implausibly far from the rest: one old multi-area graphic can tie a substation to a suburb across the city.
 * A place is kept when it is within max(6 km, 2.5x the median distance) of the origin.
 */
export function withoutOutliers(places, origin) {
  if (places.length < 4) return places;
  const d = places.map((p) => km([p.lon, p.lat], origin)).sort((x, y) => x - y);
  const limit = Math.max(6, 2.5 * d[Math.floor(d.length / 2)]);
  return places.filter((p) => km([p.lon, p.lat], origin) <= limit);
}

/** Every substation, switching station and distributor that has at least one placed suburb. */
export async function equipmentHubs() {
  const rows = await prisma.nodeLocality.findMany({
    where: { locality: { lat: { not: null } }, node: { type: { in: HUB_TYPES } } },
    select: { nodeId: true, evidenceCount: true, locality: { select: { id: true, lat: true, lon: true } }, node: { select: { id: true, name: true, type: true } } },
  });
  const byNode = new Map();
  for (const r of rows) {
    const cur = byNode.get(r.nodeId) ?? { node: r.node, pts: [] };
    cur.pts.push({ id: r.locality.id, lat: r.locality.lat, lon: r.locality.lon, w: r.evidenceCount || 1 });
    byNode.set(r.nodeId, cur);
  }
  const ids = [...byNode.keys()];
  const [liveRows, parents] = await Promise.all([
    prisma.outageNode.findMany({ where: { nodeId: { in: ids }, outage: { status: { in: LIVE } } }, select: { nodeId: true } }),
    prisma.infraEdge.findMany({ where: { childId: { in: ids } }, orderBy: { evidenceCount: 'desc' }, select: { childId: true, parentId: true } }),
  ]);
  const live = new Set(liveRows.map((r) => r.nodeId));
  const parentOf = new Map();
  for (const e of parents) if (!parentOf.has(e.childId)) parentOf.set(e.childId, e.parentId);
  return [...byNode.values()]
    .map(({ node, pts }) => {
      const c = weightedCentre(pts);
      return c && { id: node.id, name: node.name, type: node.type, lon: c[0], lat: c[1], served: pts.length, live: live.has(node.id), parentId: parentOf.get(node.id) ?? null };
    })
    .filter(Boolean);
}

/**
 * The connections to animate for one piece of equipment: equipment -> the distributors under it -> the suburbs they serve
 * (a suburb hangs off the downstream piece that names it most often, otherwise straight off the equipment itself).
 */
export async function equipmentFlow(rootId, places) {
  const hubs = await equipmentHubs();
  const hubById = new Map(hubs.map((h) => [h.id, h]));
  const root = hubById.get(rootId);
  const rootPts = places.map((p) => ({ lat: p.lat, lon: p.lon, w: p.evidence || 1 }));
  const origin = root ? [root.lon, root.lat] : weightedCentre(rootPts);
  if (!origin) return { origin: null, children: [], edges: [] };

  const kids = await prisma.infraEdge.findMany({ where: { parentId: rootId }, orderBy: { evidenceCount: 'desc' }, take: 40, select: { childId: true } });
  const allKids = kids.map((k) => hubById.get(k.childId)).filter(Boolean);
  // a circuit whose inferred position is far from its parent is drawn from the parent instead (its own centre is skewed by a far-off suburb)
  const nearIds = new Set(withoutOutliers(allKids, origin).map((c) => c.id));
  const children = allKids.map((c) => ({ ...c, near: nearIds.has(c.id) }));
  const childIds = children.filter((c) => c.near).map((c) => c.id);
  const served = childIds.length
    ? await prisma.nodeLocality.findMany({ where: { nodeId: { in: childIds } }, select: { nodeId: true, localityId: true, evidenceCount: true } })
    : [];
  const best = new Map(); // suburb -> the child that names it most
  for (const s of served) if (!best.has(s.localityId) || s.evidenceCount > best.get(s.localityId).evidenceCount) best.set(s.localityId, s);

  const edges = children.filter((c) => c.near).map((c) => ({ from: origin, to: [c.lon, c.lat], toId: c.id, kind: 'equipment', live: c.live }));
  // draw the well-supported connections: a suburb named once in a big multi-area graphic is weak evidence (and stretches the map)
  const strong = places.filter((p) => (p.evidence ?? 1) >= 2);
  for (const p of withoutOutliers(strong.length >= 3 ? strong : places, origin).slice(0, 150)) {
    const via = best.get(p.id);
    const child = via && hubById.get(via.nodeId);
    edges.push({ from: child ? [child.lon, child.lat] : origin, to: [p.lon, p.lat], toId: p.id, kind: 'suburb', live: Boolean(p.live) });
  }
  return { origin, children, edges };
}
