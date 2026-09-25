import { prisma } from '../../db/prisma.js';

// Where City Power's equipment "is" on the map. City Power publishes no coordinates for it, so a piece of equipment is
// drawn at the centre of the suburbs it is known to serve (weighted by how often posts tied them together).
// That is an inference, and the map says so. The connections (which suburbs it feeds) are real, learned from City Power's own posts.

const HUB_TYPES = ['SDC', 'SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR'];
const WATER_MAP_TYPES = ['RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'PRV', 'DIRECT_FEED', 'WATER_SYSTEM', 'TREATMENT_WORKS', 'BOOSTER_STATION'];
const SUPPLY_TYPES = new Set(['SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR', 'MINI_SUBSTATION', 'FEEDER', 'WATER_PIPELINE', 'BULK_CONNECTION', ...WATER_MAP_TYPES]);
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

/** Include downstream suburbs for service centres, deduplicated and safe against graph cycles. */
export function serviceCentrePlaces(rootId, byNode, edges) {
  const ids = new Set([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const parents = new Set(frontier);
    frontier = edges.filter((e) => parents.has(e.parentId) && !ids.has(e.childId)).map((e) => e.childId);
    frontier.forEach((id) => ids.add(id));
  }
  const places = new Map();
  for (const id of ids) {
    for (const point of byNode.get(id)?.pts ?? []) {
      const current = places.get(point.id);
      places.set(point.id, { ...point, w: (current?.w ?? 0) + point.w });
    }
  }
  return [...places.values()];
}

/** Facilities with mapped suburbs; service centres also inherit their downstream suburbs.
 * `municipality` (a Municipality code) keeps only hubs that serve at least one suburb there - equipment near a
 * boundary can genuinely serve more than one municipality, so a hub's position is still the centre of everything
 * it serves, not recomputed from just that municipality's share. */
export async function equipmentHubs(municipality) {
  const rows = await prisma.nodeLocality.findMany({
    where: { locality: { lat: { not: null }, lon: { not: null } } },
    select: { nodeId: true, evidenceCount: true, locality: { select: { id: true, lat: true, lon: true, Region: { select: { Municipality: { select: { code: true } } } } } }, node: { select: { id: true, name: true, type: true } } },
  });
  const byNode = new Map();
  for (const r of rows) {
    const cur = byNode.get(r.nodeId) ?? { node: r.node, pts: [] };
    cur.pts.push({ id: r.locality.id, lat: r.locality.lat, lon: r.locality.lon, w: r.evidenceCount || 1, municipality: r.locality.Region?.Municipality?.code ?? null });
    byNode.set(r.nodeId, cur);
  }
  const [liveRows, parents, centres, sdcOutages] = await Promise.all([
    prisma.outageNode.findMany({ where: { nodeId: { in: [...byNode.keys()] }, outage: { status: { in: LIVE } } }, select: { nodeId: true } }),
    prisma.infraEdge.findMany({ orderBy: { evidenceCount: 'desc' }, select: { childId: true, parentId: true } }),
    prisma.infraNode.findMany({ where: { type: 'SDC' }, select: { id: true, name: true, type: true } }),
    prisma.outage.findMany({ where: { status: { in: LIVE }, sdcName: { not: null } }, select: { sdcName: true }, distinct: ['sdcName'] }),
  ]);
  const live = new Set(liveRows.map((r) => r.nodeId));
  const liveSdcs = new Set(sdcOutages.map((r) => r.sdcName));
  const centreHubs = centres.map((node) => ({ node, pts: serviceCentrePlaces(node.id, byNode, parents) }));
  for (const hub of centreHubs) {
    byNode.set(hub.node.id, hub);
    if (liveSdcs.has(hub.node.name)) live.add(hub.node.id);
  }
  const parentOf = new Map();
  for (const e of parents) if (!parentOf.has(e.childId)) parentOf.set(e.childId, e.parentId);
  const code = municipality?.toUpperCase();
  return [...byNode.values()]
    .filter(({ node }) => HUB_TYPES.includes(node.type))
    .filter(({ pts }) => !code || pts.some((p) => p.municipality === code))
    .map(({ node, pts }) => {
      const c = weightedCentre(pts);
      return c && { id: node.id, name: node.name, type: node.type, lon: c[0], lat: c[1], served: pts.length, live: live.has(node.id), parentId: parentOf.get(node.id) ?? null };
    })
    .filter(Boolean);
}

/** A water asset drawn at its own coordinates, or at the centre of the suburbs posts have tied to it. */
export function placeWaterHub(node, live = false) {
  const pts = (node.localities ?? [])
    .map((row) => ({ lat: row.locality?.lat, lon: row.locality?.lon, w: row.evidenceCount || 1 }))
    .filter((point) => point.lat != null && point.lon != null);
  const centre = node.lat != null && node.lon != null ? [node.lon, node.lat] : weightedCentre(pts);
  if (!centre) return null;
  return {
    id: node.id, name: node.name, type: node.type, lon: centre[0], lat: centre[1], served: pts.length, live: Boolean(live),
    boundary: node.boundary ?? null, derived: node.lat == null || node.lon == null,
  };
}

/** Water facilities for the infrastructure map. Electricity hubs stay on `equipmentHubs`. */
export async function waterMapHubs(municipality) {
  const code = municipality?.toUpperCase();
  const nodes = await prisma.infraNode.findMany({
    where: {
      serviceType: 'WATER',
      type: { in: WATER_MAP_TYPES },
      ...(code ? { OR: [{ Municipality: { code } }, { municipalityId: null, localities: { some: { locality: { Region: { Municipality: { code } } } } } }] } : {}),
    },
    select: {
      id: true, name: true, type: true, lat: true, lon: true, boundary: true,
      localities: { select: { evidenceCount: true, locality: { select: { lat: true, lon: true } } } },
    },
    orderBy: { name: 'asc' },
    take: 200,
  });
  const liveRows = nodes.length
    ? await prisma.outageNode.findMany({ where: { nodeId: { in: nodes.map((node) => node.id) }, outage: { status: { in: LIVE }, serviceType: 'WATER' } }, select: { nodeId: true } })
    : [];
  const live = new Set(liveRows.map((row) => row.nodeId));
  return nodes.map((node) => placeWaterHub(node, live.has(node.id))).filter(Boolean);
}

/** Suburb plus the power and water assets posts have tied to it, each placed on the map. */
export function supplyView(locality, links, pointsByNode, liveIds) {
  const assets = [];
  for (const link of links) {
    const node = link.node;
    if (!node || !SUPPLY_TYPES.has(node.type)) continue;
    const centre = node.lat != null && node.lon != null ? [node.lon, node.lat] : weightedCentre(pointsByNode.get(node.id) ?? []);
    if (!centre) continue;
    assets.push({
      id: node.id, name: node.name, type: node.type, service: node.serviceType,
      lon: centre[0], lat: centre[1], evidence: link.evidenceCount ?? 0, live: liveIds.has(node.id),
    });
  }
  assets.sort((a, b) => b.evidence - a.evidence || String(a.name).localeCompare(String(b.name)));
  return {
    locality: { id: locality.id, name: locality.canonicalName ?? locality.name, lat: locality.lat ?? null, lon: locality.lon ?? null, boundary: locality.boundary ?? null },
    assets,
  };
}

export async function localitySupply(localityId) {
  const locality = await prisma.locality.findUnique({
    where: { id: localityId },
    select: {
      id: true, canonicalName: true, lat: true, lon: true, boundary: true,
      nodes: { orderBy: { evidenceCount: 'desc' }, select: { evidenceCount: true, node: { select: { id: true, name: true, type: true, serviceType: true, lat: true, lon: true } } } },
    },
  });
  if (!locality) return null;
  const ids = locality.nodes.map((row) => row.node.id);
  const [rows, liveRows] = await Promise.all([
    ids.length ? prisma.nodeLocality.findMany({ where: { nodeId: { in: ids }, locality: { lat: { not: null }, lon: { not: null } } }, select: { nodeId: true, evidenceCount: true, locality: { select: { lat: true, lon: true } } } }) : [],
    ids.length ? prisma.outageNode.findMany({ where: { nodeId: { in: ids }, outage: { status: { in: LIVE } } }, select: { nodeId: true } }) : [],
  ]);
  const pointsByNode = new Map();
  for (const row of rows) {
    const list = pointsByNode.get(row.nodeId) ?? [];
    list.push({ lat: row.locality.lat, lon: row.locality.lon, w: row.evidenceCount || 1 });
    pointsByNode.set(row.nodeId, list);
  }
  return supplyView(locality, locality.nodes, pointsByNode, new Set(liveRows.map((row) => row.nodeId)));
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
