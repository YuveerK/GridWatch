import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { assertLeaseInTx } from '../coordination/lease.js';
import { differsByLabel, infraKey, isNotSuburbName, likelyTypo, localityKey, similarity, tailPlace, oneEditApart } from '../../lib/normalize.js';
import { decodeEdgeEvidenceRef, edgeEvidenceRef } from '../../lib/evidence-edge.js';

const FUZZY_NODE = 0.9;
const FUZZY_LOCALITY = 0.92;
const CONFIRM_AT = 2;
const STATION_TYPES = ['SUBSTATION', 'SWITCHING_STATION'];
// A street or a cable route is read as a cable in one post, a line in the next and "other" in a third ("Amanda Avenue"). The reader's guess at
// which of these it is does not change what it is, so the same name is the same thing across them. (Never across a station or a distributor.)
const MINOR_TYPES = ['CABLE', 'LINE', 'OTHER'];
const WATER_TYPES = new Set(['WATER_SYSTEM', 'RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'DIRECT_FEED', 'BULK_CONNECTION', 'BULK_METER', 'BOOSTER_STATION', 'TREATMENT_WORKS', 'PRV', 'WATER_PIPELINE', 'WATER_OTHER']);

let localityIndex = null;

// Every authoritative write to the graph runs in a transaction that first proves the caller still holds the pipeline lease (a worker that
// lost it, and has not noticed yet, must not write). `ctx` is that lease; without one (scripts, tests) nothing is checked.
const fenced = (ctx, fn) =>
  prisma.$transaction(async (tx) => {
    await assertLeaseInTx(tx, ctx);
    return fn(tx);
  });

// ── idempotent evidence ──────────────────────────────────────────────────────────────────────
// Each fact a post teaches the graph (this equipment exists, this feeds that, this serves that suburb) is recorded once per
// source (postId + faultIndex). The counters only move when that record is first written, so retrying a post, or reprocessing
// it, can never inflate them. `source` is { postId, faultIndex } (omit it for the old always-count behaviour).
// mode 'record-only' writes the records without touching counters: used to adopt data that was counted before records existed.

/** Inserts the contribution record; true when it is new AND the counter should move. */
async function shouldCount(db, source, kind, refA, refB = '', mode = 'count') {
  if (!source) return true;
  const { count } = await db.evidenceContribution.createMany({ data: [{ postId: source.postId, faultIndex: source.faultIndex ?? 0, kind, refA, refB }], skipDuplicates: true });
  return count === 1 && mode !== 'record-only';
}

/** Take back everything one source taught the graph (before it is learned again, or when it is removed). */
export async function removeContributions(postId, faultIndex = null, { ctx } = {}) {
  const where = { postId, ...(faultIndex == null ? {} : { faultIndex }) };
  const rows = await prisma.evidenceContribution.findMany({ where });
  if (!rows.length) return { removed: 0 };
  await prisma.$transaction(async (tx) => {
    await assertLeaseInTx(tx, ctx);
    for (const r of rows) {
      if (r.kind === 'NODE') {
        const n = await tx.infraNode.findUnique({ where: { id: r.refA } });
        if (n) {
          const evidenceCount = Math.max(0, n.evidenceCount - 1); // may reach 0: then nothing currently supports it, and re-learning restores it exactly
          await tx.infraNode.update({ where: { id: n.id }, data: { evidenceCount, lifecycle: n.lifecycle === 'CONFIRMED' && evidenceCount < CONFIRM_AT ? 'CANDIDATE' : n.lifecycle } });
        }
      } else if (r.kind === 'EDGE') {
        const { relationType, childId } = decodeEdgeEvidenceRef(r.refB);
        const key = { parentId_childId_relationType: { parentId: r.refA, childId, relationType } };
        const e = await tx.infraEdge.findUnique({ where: key });
        if (e) {
          if (e.evidenceCount <= 1) await tx.infraEdge.delete({ where: key });
          else await tx.infraEdge.update({ where: key, data: { evidenceCount: { decrement: 1 } } });
        }
      } else if (r.kind === 'NODE_LOCALITY') {
        const key = { nodeId_localityId: { nodeId: r.refA, localityId: r.refB } };
        const l = await tx.nodeLocality.findUnique({ where: key });
        if (l) {
          if (l.evidenceCount <= 1) await tx.nodeLocality.delete({ where: key });
          else await tx.nodeLocality.update({ where: key, data: { evidenceCount: { decrement: 1 } } });
        }
      }
    }
    await tx.evidenceContribution.deleteMany({ where });
  });
  return { removed: rows.length };
}

const baseName = (key) => key.replace(/\s+ext(\s+\d+)*(\s+and\s+\d+)*$/, '').trim();

/** name → [Locality] built from canonical names + aliases (loaded once; geography is static). */
async function getLocalityIndex() {
  if (localityIndex) return localityIndex;
  const [locs, aliases] = await Promise.all([
    prisma.locality.findMany({ where: { active: true }, include: { Region: true }, orderBy: [{ canonicalName: 'asc' }, { regionId: 'asc' }, { sourceLine: 'asc' }] }),
    prisma.localityAlias.findMany({ where: { status: { not: 'REJECTED' } }, orderBy: [{ normalizedAlias: 'asc' }, { alias: 'asc' }] }),
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

/** Returns Locality | null. Ambiguous names (same suburb in several regions) prefer `preferIds`.
 * When `municipalityId` is known, a candidate is only ever returned if it belongs to that municipality or has never been
 * attributed to any municipality - a candidate known to belong to a DIFFERENT municipality is never returned, not even as a
 * last resort (a same-named suburb in two tracked utilities is not the same place without explicit evidence). */
export async function resolveLocality(name, preferIds = new Set(), municipalityId = null) {
  const { map, keys } = await getLocalityIndex();
  const key = localityKey(name);
  const inScope = (list) => {
    if (!list?.length || municipalityId == null) return list ?? null;
    const scoped = list.filter((c) => c.municipalityId === municipalityId || c.municipalityId == null);
    return scoped.length ? scoped : null;
  };
  let candidates = inScope(map.get(key));
  if (!candidates) {
    const stripped = key.replace(/ ext( \d+)*( and \d+)*$/, '').trim();
    candidates = inScope(map.get(stripped));
  }
  if (!candidates && key.length >= 5) {
    let best = null;
    let bestScore = 0;
    for (const k of keys) {
      if (!inScope(map.get(k))) continue; // a key with no in-scope candidate is never a fuzzy match target
      const s = similarity(key, k);
      if (s > bestScore) [best, bestScore] = [k, s];
    }
    if (bestScore >= FUZZY_LOCALITY) candidates = inScope(map.get(best));
  }
  // a single mistyped letter ("Develand" for "Devland") is the same suburb: without this the typo became a new, unplaced suburb
  if (!candidates && key.length >= 6 && !/\d/.test(key)) {
    const near = keys.filter((k) => k[0] === key[0] && oneEditApart(key, k) && inScope(map.get(k)));
    if (near.length === 1) candidates = inScope(map.get(near[0]));
  }
  if (!candidates?.length) return null;
  return candidates.find((c) => preferIds.has(c.id)) ?? candidates[0];
}

/** Suburbs missing from the supplied list are learned as candidates (streets/facilities are ignored). A learned locality is
 * tagged with the resolving municipality when known, so a later post from a different municipality never reuses it. */
async function learnLocality(name, ctx, municipalityId = null) {
  const clean = name.trim();
  const key = localityKey(clean);
  if (key.length < 3 || isNotSuburbName(clean)) return null;
  const scope = municipalityId != null ? { OR: [{ municipalityId }, { municipalityId: null }] } : {};
  let loc = await prisma.locality.findFirst({ where: { normalizedName: key, regionId: null, ...scope } });
  if (!loc) {
    loc = await fenced(ctx, (tx) =>
      tx.locality.create({
        data: { id: randomUUID(), canonicalName: clean, normalizedName: key, municipalityId, sourceLabel: 'learned-from-posts', updatedAt: new Date() },
      }),
    );
  }
  resetLocalityIndex();
  return loc;
}

/** Find or create a node; bumps evidence and promotes to CONFIRMED. */
const JUNK_NAME = /^(affected|unspecified|unspecific|unnamed|tbc|unknown|customers?|areas?|surrounding( areas)?|n\/a|none|the|a|an|feeder|line|cable|mini[- ]?substation|substation|distributor)$/i;

export async function resolveNode({ type, name, at, source = null, mode = 'count', ctx, municipalityId = null, serviceType = 'ELECTRICITY' }) {
  if (!name || JUNK_NAME.test(name.trim())) return null;
  // "Inner City", "InnerCity" and "InnerCitySDC" are one service delivery centre
  const key = type === 'SDC' ? infraKey(name).replace(/\s+/g, '').replace(/sdc$/, '') : infraKey(name);
  if (!key) return null;
  // Equipment identity is namespaced by municipality: when the caller knows it, EVERY lookup below is scoped to it exactly -
  // never falling back to a null-municipality row or a row known to belong to a different municipality. A same-named station
  // in two different tracked utilities is only ever the same node with explicit evidence, which nothing here supplies. When
  // the caller doesn't know the municipality (tests, or a code path with no account context), lookups stay global/unscoped,
  // exactly as before this existed.
  const scope = { serviceType, ...(municipalityId != null ? { municipalityId } : {}) };
  let node = await prisma.infraNode.findFirst({ where: { type, normalizedKey: key, ...scope } });
  // "X Substation" and "X Switching Station" are written interchangeably for the same site.
  if (!node && STATION_TYPES.includes(type)) {
    node = await prisma.infraNode.findFirst({ where: { normalizedKey: key, type: { in: STATION_TYPES }, ...scope }, orderBy: { evidenceCount: 'desc' } });
  }
  if (!node && serviceType !== 'WATER' && MINOR_TYPES.includes(type)) {
    node = await prisma.infraNode.findFirst({ where: { normalizedKey: key, type: { in: MINOR_TYPES }, ...scope }, orderBy: [{ evidenceCount: 'desc' }, { firstSeenAt: 'asc' }] });
  }
  // "Roosevelt Park" and "Roosevelt" (one plain-word suffix) are the same substation.
  if (!node && STATION_TYPES.includes(type) && key.length >= 4) {
    const stations = await prisma.infraNode.findMany({ where: { type: { in: STATION_TYPES }, ...scope }, orderBy: [{ evidenceCount: 'desc' }, { normalizedKey: 'asc' }] });
    const plainSuffix = (long, short) => long.startsWith(`${short} `) && /^[a-z]+$/.test(long.slice(short.length + 1));
    node = stations.find((n) => plainSuffix(n.normalizedKey, key) || plainSuffix(key, n.normalizedKey)) ?? null;
  }
  if (!node) {
    const alias = await prisma.nodeAlias.findFirst({ where: { normalizedKey: key, node: { type, ...scope } }, include: { node: true } });
    node = alias?.node ?? null;
  }
  if (!node && key.length >= 5) {
    const peers = await prisma.infraNode.findMany({ where: { type, ...scope }, select: { id: true, normalizedKey: true }, orderBy: { normalizedKey: 'asc' } });
    let best = null;
    let bestScore = 0;
    for (const p of peers) {
      if (differsByLabel(key, p.normalizedKey)) continue;
      const s = similarity(key, p.normalizedKey);
      if (s > bestScore) [best, bestScore] = [p, s];
    }
    if (best && bestScore >= FUZZY_NODE) {
      node = await prisma.infraNode.findUnique({ where: { id: best.id } });
      await fenced(ctx, (tx) =>
        tx.nodeAlias.upsert({
          where: { nodeId_normalizedKey: { nodeId: node.id, normalizedKey: key } },
          create: { nodeId: node.id, alias: name, normalizedKey: key },
          update: {},
        }),
      );
    }
  }
  // a station name that is one letter off, or the same letters scrambled, is a misspelling of a known station (only when exactly one fits)
  if (!node && STATION_TYPES.includes(type) && key.length >= 7) {
    const stations = await prisma.infraNode.findMany({ where: { type: { in: STATION_TYPES }, ...scope }, select: { id: true, normalizedKey: true } });
    const near = stations.filter((n) => !differsByLabel(key, n.normalizedKey) && likelyTypo(key, n.normalizedKey));
    if (near.length === 1) {
      node = await prisma.infraNode.findUnique({ where: { id: near[0].id } });
      await fenced(ctx, (tx) => tx.nodeAlias.upsert({ where: { nodeId_normalizedKey: { nodeId: node.id, normalizedKey: key } }, create: { nodeId: node.id, alias: name, normalizedKey: key }, update: {} }));
    }
  }
  // The contribution record and the counter move together or not at all: a failure between them used to leave the record written and the
  // counter unmoved, so a retry saw "already counted" and the evidence was lost for good.
  if (node) {
    return fenced(ctx, async (tx) => {
      const count = await shouldCount(tx, source, 'NODE', node.id, '', mode);
      const updated = await tx.infraNode.update({
        where: { id: node.id },
        data: {
          ...(count ? { evidenceCount: { increment: 1 } } : {}),
          lastSeenAt: at > node.lastSeenAt ? at : node.lastSeenAt,
          firstSeenAt: at < node.firstSeenAt ? at : node.firstSeenAt,
        },
      });
      if (updated.lifecycle === 'CANDIDATE' && updated.evidenceCount >= CONFIRM_AT) return tx.infraNode.update({ where: { id: node.id }, data: { lifecycle: 'CONFIRMED' } });
      return updated;
    });
  }
  return fenced(ctx, async (tx) => {
    const created = await tx.infraNode.create({ data: { type, name: name.trim(), normalizedKey: key, municipalityId, serviceType, firstSeenAt: at, lastSeenAt: at } });
    await shouldCount(tx, source, 'NODE', created.id, '', 'record-only'); // its first evidence is already the initial 1
    return created;
  });
}

async function bumpEdge(parentId, childId, at, source, mode, ctx, relationType = 'LEGACY_PARENT') {
  if (parentId === childId) return; // never a self-link
  const refB = edgeEvidenceRef(childId, relationType);
  await prisma.$transaction(async (tx) => {
    await assertLeaseInTx(tx, ctx);
    const count = await shouldCount(tx, source, 'EDGE', parentId, refB, mode);
    await tx.infraEdge.upsert({
      where: { parentId_childId_relationType: { parentId, childId, relationType } },
      create: { parentId, childId, relationType, lastSeenAt: at },
      update: { ...(count ? { evidenceCount: { increment: 1 } } : {}), lastSeenAt: at },
    });
  });
}

async function bumpNodeLocality(nodeId, localityId, at, source, mode, ctx) {
  await prisma.$transaction(async (tx) => {
    await assertLeaseInTx(tx, ctx);
    const count = await shouldCount(tx, source, 'NODE_LOCALITY', nodeId, localityId, mode);
    await tx.nodeLocality.upsert({
      where: { nodeId_localityId: { nodeId, localityId } },
      create: { nodeId, localityId, lastSeenAt: at },
      update: { ...(count ? { evidenceCount: { increment: 1 } } : {}), lastSeenAt: at },
    });
  });
}

// Which type may be the parent of which (lower number = higher in the chain). A name that matches several nodes of different
// types is resolved by asking "which of them could actually be this thing's parent?", never by guessing.
const RANK = { SDC: 0, SUBSTATION: 1, SWITCHING_STATION: 1, FEEDER: 2, DISTRIBUTOR: 2, CIRCUIT: 2, LINE: 3, MINI_SUBSTATION: 3, TRANSFORMER: 4, KIOSK: 4, CABLE: 5, OTHER: 6 };

/** The node an entity's parent_name refers to, or null when it is missing or genuinely ambiguous. Never the node itself. */
export function pickParent(node, candidates) {
  const options = candidates.filter((c) => c.node.id !== node.id);
  if (!options.length) return null;
  const higher = options.filter((c) => (RANK[c.node.type] ?? 9) < (RANK[node.type] ?? 9));
  const differentType = options.filter((c) => c.node.type !== node.type);
  // A post can name its parent explicitly even when the network cascades within one type (a substation feeding other substations,
  // as Tshwane's posts do) - the post SAID so, so it is trusted like any other named parent, not silently dropped for lacking a rank
  // difference. Still never guessed: several equally plausible candidates at the same type fall through to "ambiguous" below as before.
  const pool = higher.length ? higher : differentType.length ? differentType : options;
  if (!pool.length) return null;
  const best = Math.min(...pool.map((c) => RANK[c.node.type] ?? 9));
  const top = pool.filter((c) => (RANK[c.node.type] ?? 9) === best);
  return new Set(top.map((c) => c.node.id)).size === 1 ? top[0] : null; // several equally plausible, different nodes: ambiguous
}

/**
 * Learn from one extraction. Returns the facts the linker needs:
 * { sdcNode, nodes: [InfraNode] (non-SDC, most specific last), localityIds: [], restoredLocalityIds: [], unmatched: [] }
 */
export async function learnFromExtraction(extraction, at, { source = null, mode = 'count', ctx, municipalityId = null, serviceType = 'ELECTRICITY' } = {}) {
  const result = extraction.result;
  const listed = result.entities ?? [];
  const sdcName = result.sdc ?? listed.find((e) => e.type === 'SDC')?.name ?? null;
  const sdcNode = sdcName && serviceType !== 'WATER' ? await resolveNode({ type: 'SDC', name: sdcName, at, source, mode, ctx, municipalityId, serviceType }) : null;

  // A bare line/feeder label ("A", "D", "1B") is only meaningful with its station: "Tshepisong A".
  const stationNames = listed.filter((e) => ['SUBSTATION', 'SWITCHING_STATION'].includes(e.type)).map((e) => e.name);
  const entities = listed
    .filter((e) => e.type !== 'SDC')
    .map((e) => {
      if (!/^([A-Za-z0-9]{1,2}|(no\.?\s*)?\d+[a-z]?)$/i.test(e.name.trim())) return e;
      const station = e.parent_name ?? (stationNames.length === 1 ? stationNames[0] : null);
      return station ? { ...e, name: `${station} ${e.name.trim()}`, parent_name: e.parent_name ?? station } : e;
    });
  // Identity is the node itself (type + name), not just the name: a "Central" substation and a "Central" distributor are two nodes.
  const resolved = new Map(); // node.id → { node, entities: [entity] }
  const byName = new Map(); // infraKey(name) → [{ node }]  (every node that name could mean)
  for (const e of entities) {
    if (serviceType === 'WATER' && !WATER_TYPES.has(e.type)) continue;
    const node = await resolveNode({ type: e.type, name: e.name, at, source, mode, ctx, municipalityId, serviceType });
    if (!node) continue;
    const cur = resolved.get(node.id) ?? { node, entities: [] };
    cur.entities.push(e);
    resolved.set(node.id, cur);
    const k = infraKey(e.name);
    const list = byName.get(k) ?? [];
    if (!list.some((x) => x.node.id === node.id)) list.push({ node });
    byName.set(k, list);
  }

  const children = new Set();
  const hasParent = new Set();
  for (const { node, entities: es } of resolved.values()) {
    const named = es.find((x) => x.parent_name);
    const parent = named ? pickParent(node, byName.get(infraKey(named.parent_name)) ?? []) : null;
    if (parent) {
      await bumpEdge(parent.node.id, node.id, at, source, mode, ctx, serviceType === 'WATER' ? named.relationType ?? 'SUPPLIES' : 'LEGACY_PARENT');
      children.add(parent.node.id);
      hasParent.add(node.id);
    } else if (sdcNode) {
      // no parent named, or a named parent that could not be resolved unambiguously: attach to the service centre rather than guess
      await bumpEdge(sdcNode.id, node.id, at, source, mode, ctx);
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
    let loc = (await resolveLocality(l.name, preferIds, municipalityId)) ?? (await learnLocality(l.name, ctx, municipalityId));
    if (!loc && tailPlace(l.name)) loc = (await resolveLocality(tailPlace(l.name), preferIds, municipalityId)) ?? (await learnLocality(tailPlace(l.name), ctx, municipalityId));
    if (!loc) {
      unmatched.push(l.name);
      continue;
    }
    if (!localityIds.includes(loc.id)) localityIds.push(loc.id);
    if (l.state === 'RESTORED') restoredLocalityIds.push(loc.id);
    for (const leaf of leaves) await bumpNodeLocality(leaf.id, loc.id, at, source, mode, ctx);
  }
  // Independent branches: a normal substation → distributor chain is 1; a multi-fault digest image is 3+.
  const rootCount = nodes.filter((n) => !hasParent.has(n.id)).length;
  return { sdcNode, nodes, rootCount, localityIds, restoredLocalityIds, unmatched, municipalityId, serviceType };
}
