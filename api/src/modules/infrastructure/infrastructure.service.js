import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { infraKey, localityKey, similarity } from '../../lib/normalize.js';

const FUZZY_NODE = 0.9;
const FUZZY_LOCALITY = 0.92;
const CONFIRM_AT = 2;

let localityIndex = null;

const baseName = (key) => key.replace(/\s+ext(\s+\d+)*(\s+and\s+\d+)*$/, '').trim();
const NOT_A_SUBURB = /((street|st|road|rd|avenue|ave|drive|dr|lane|centre|center|clinic|water|hospital|school|mall|station)|^\d|to|parts? of)/i;

/** name → [Locality] built from canonical names + aliases (loaded once; geography is static). */
async function getLocalityIndex() {
  if (localityIndex) return localityIndex;
  const [locs, aliases] = await Promise.all([
    prisma.locality.findMany({ where: { active: true }, include: { Region: true } }),
    prisma.localityAlias.findMany({ where: { status: { not: 'REJECTED' } } }),
  ]);
  const byId = new Map(locs.map((l) => [l.id, l]));
  const map = new Map();
  const add = (key, loc) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((x) => x.id === loc.id)) list.push(loc);
    map.set(key, list);
  };
  for (const l of locs) {
    add(l.normalizedName, l);
    add(localityKey(l.canonicalName), l);
  }
  // "Highlands North Extension" / "Highlands North Ext 2" also answer to the base name "Highlands North".
  for (const l of locs) {
    const base = baseName(localityKey(l.canonicalName));
    if (base && !map.has(base)) add(base, l);
  }
  for (const a of aliases) if (byId.has(a.localityId)) add(a.normalizedAlias, byId.get(a.localityId));
  localityIndex = { map, keys: [...map.keys()] };
  return localityIndex;
}

export function resetLocalityIndex() {
  localityIndex = null;
}

/** Returns Locality | null. Ambiguous names (same suburb in several regions) prefer `preferIds`. */
export async function resolveLocality(name, preferIds = new Set()) {
  const { map, keys } = await getLocalityIndex();
  const key = localityKey(name);
  let candidates = map.get(key);
  if (!candidates) {
    const stripped = key.replace(/ ext( \d+)*( and \d+)*$/, '').trim();
    candidates = map.get(stripped);
  }
  if (!candidates && key.length >= 5) {
    let best = null;
    let bestScore = 0;
    for (const k of keys) {
      const s = similarity(key, k);
      if (s > bestScore) [best, bestScore] = [k, s];
    }
    if (bestScore >= FUZZY_LOCALITY) candidates = map.get(best);
  }
  if (!candidates?.length) return null;
  return candidates.find((c) => preferIds.has(c.id)) ?? candidates[0];
}

/** Suburbs missing from the supplied list are learned as candidates (streets/facilities are ignored). */
async function learnLocality(name) {
  const clean = name.trim();
  const key = localityKey(clean);
  if (key.length < 3 || NOT_A_SUBURB.test(clean)) return null;
  let loc = await prisma.locality.findFirst({ where: { normalizedName: key, regionId: null } });
  if (!loc) {
    loc = await prisma.locality.create({
      data: { id: randomUUID(), canonicalName: clean, normalizedName: key, sourceLabel: 'learned-from-posts', updatedAt: new Date() },
    });
  }
  resetLocalityIndex();
  return loc;
}

/** Find or create a node; bumps evidence and promotes to CONFIRMED. */
const JUNK_NAME = /^(affected|unknown|customers?|areas?|surrounding( areas)?|n\/a|none|the|a|an|feeder|line|cable|mini[- ]?substation|substation|distributor)$/i;

export async function resolveNode({ type, name, at }) {
  if (!name || JUNK_NAME.test(name.trim())) return null;
  const key = type === 'SDC' ? infraKey(name).replace(/\s+/g, '') : infraKey(name);
  if (!key) return null;
  let node = await prisma.infraNode.findUnique({ where: { type_normalizedKey: { type, normalizedKey: key } } });
  if (!node) {
    const alias = await prisma.nodeAlias.findFirst({ where: { normalizedKey: key, node: { type } }, include: { node: true } });
    node = alias?.node ?? null;
  }
  if (!node && key.length >= 5) {
    const peers = await prisma.infraNode.findMany({ where: { type }, select: { id: true, normalizedKey: true } });
    let best = null;
    let bestScore = 0;
    for (const p of peers) {
      const s = similarity(key, p.normalizedKey);
      if (s > bestScore) [best, bestScore] = [p, s];
    }
    if (best && bestScore >= FUZZY_NODE) {
      node = await prisma.infraNode.findUnique({ where: { id: best.id } });
      await prisma.nodeAlias.upsert({
        where: { nodeId_normalizedKey: { nodeId: node.id, normalizedKey: key } },
        create: { nodeId: node.id, alias: name, normalizedKey: key },
        update: {},
      });
    }
  }
  if (node) {
    const evidenceCount = node.evidenceCount + 1;
    return prisma.infraNode.update({
      where: { id: node.id },
      data: {
        evidenceCount,
        lastSeenAt: at > node.lastSeenAt ? at : node.lastSeenAt,
        firstSeenAt: at < node.firstSeenAt ? at : node.firstSeenAt,
        lifecycle: node.lifecycle === 'CANDIDATE' && evidenceCount >= CONFIRM_AT ? 'CONFIRMED' : node.lifecycle,
      },
    });
  }
  return prisma.infraNode.create({ data: { type, name: name.trim(), normalizedKey: key, firstSeenAt: at, lastSeenAt: at } });
}

async function bumpEdge(parentId, childId, at) {
  if (parentId === childId) return;
  await prisma.infraEdge.upsert({
    where: { parentId_childId: { parentId, childId } },
    create: { parentId, childId, lastSeenAt: at },
    update: { evidenceCount: { increment: 1 }, lastSeenAt: at },
  });
}

async function bumpNodeLocality(nodeId, localityId, at) {
  await prisma.nodeLocality.upsert({
    where: { nodeId_localityId: { nodeId, localityId } },
    create: { nodeId, localityId, lastSeenAt: at },
    update: { evidenceCount: { increment: 1 }, lastSeenAt: at },
  });
}

/**
 * Learn from one extraction. Returns the facts the linker needs:
 * { sdcNode, nodes: [InfraNode] (non-SDC, most specific last), localityIds: [], restoredLocalityIds: [], unmatched: [] }
 */
export async function learnFromExtraction(extraction, at) {
  const result = extraction.result;
  const sdcName = result.sdc ?? result.entities.find((e) => e.type === 'SDC')?.name ?? null;
  const sdcNode = sdcName ? await resolveNode({ type: 'SDC', name: sdcName, at }) : null;

  const entities = result.entities.filter((e) => e.type !== 'SDC');
  const resolved = new Map(); // infraKey → node
  for (const e of entities) {
    const node = await resolveNode({ type: e.type, name: e.name, at });
    if (node) resolved.set(infraKey(e.name), { node, entity: e });
  }

  const children = new Set();
  for (const { node, entity } of resolved.values()) {
    const parent = entity.parent_name ? resolved.get(infraKey(entity.parent_name)) : null;
    if (parent) {
      await bumpEdge(parent.node.id, node.id, at);
      children.add(parent.node.id);
    } else if (sdcNode) {
      await bumpEdge(sdcNode.id, node.id, at);
    }
  }

  // Order nodes so the most specific (a node that is nobody's parent in this post) comes last.
  const nodes = [...resolved.values()].map((r) => r.node).sort((a, b) => Number(children.has(b.id)) - Number(children.has(a.id)));
  const leaves = nodes.filter((n) => !children.has(n.id));

  const preferIds = new Set();
  for (const n of nodes) {
    const known = await prisma.nodeLocality.findMany({ where: { nodeId: n.id }, select: { localityId: true } });
    known.forEach((k) => preferIds.add(k.localityId));
  }
  const localityIds = [];
  const restoredLocalityIds = [];
  const unmatched = [];
  for (const l of result.localities) {
    const loc = (await resolveLocality(l.name, preferIds)) ?? (await learnLocality(l.name));
    if (!loc) {
      unmatched.push(l.name);
      continue;
    }
    if (!localityIds.includes(loc.id)) localityIds.push(loc.id);
    if (l.state === 'RESTORED') restoredLocalityIds.push(loc.id);
    for (const leaf of leaves) await bumpNodeLocality(leaf.id, loc.id, at);
  }
  return { sdcNode, nodes, localityIds, restoredLocalityIds, unmatched };
}
