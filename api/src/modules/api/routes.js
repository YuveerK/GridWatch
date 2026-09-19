import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { localityKey } from '../../lib/normalize.js';
import { parseSchedule } from '../../lib/schedule.js';
import { ingestNewPosts } from '../ingestion/ingestion.service.js';
import { env } from '../../config/env.js';
import { cycle } from '../processing/cycle.js';
import { processPending, processPost } from '../processing/processor.service.js';
import { equipmentFlow, equipmentHubs } from '../geo/equipment-map.service.js';
import { regionsGeoJson } from '../geo/regions.service.js';

export const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const LIVE = ['ACTIVE', 'PARTIALLY_RESTORED'];
const HOUR = 3_600_000;
const todaySAST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());

const outageInclude = {
  localities: { include: { locality: { select: { id: true, canonicalName: true, lat: true, lon: true, Region: { select: { code: true, name: true } } } } } },
  nodes: { include: { node: { select: { id: true, type: true, name: true, lifecycle: true } } } },
  _count: { select: { posts: true } },
};

/** Areas usually served by an outage's equipment, for outages whose posts named no suburb. Marked as inferred. */
async function withLikelyAreas(outages) {
  const bare = outages.filter((o) => o.localities.length === 0 && o.nodes.length > 0);
  if (!bare.length) return outages;
  const nodeIds = [...new Set(bare.flatMap((o) => o.nodes.map((n) => n.nodeId)))];
  const [learned, nodes] = await Promise.all([
    prisma.nodeLocality.findMany({ where: { nodeId: { in: nodeIds }, evidenceCount: { gte: 3 } }, include: { locality: { select: { id: true, canonicalName: true, lat: true, lon: true } } }, orderBy: { evidenceCount: 'desc' } }),
    prisma.infraNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, normalizedKey: true } }),
  ]);
  // a station named after a suburb ("Tshepisong Switching Station") is a decent hint for that suburb
  const sameName = await prisma.locality.findMany({ where: { normalizedName: { in: nodes.map((n) => n.normalizedKey) } }, select: { id: true, canonicalName: true, normalizedName: true, lat: true, lon: true } });
  const keyById = new Map(nodes.map((n) => [n.id, n.normalizedKey]));
  for (const o of bare) {
    const seen = new Map();
    for (const n of o.nodes) {
      for (const l of learned.filter((x) => x.nodeId === n.nodeId)) seen.set(l.locality.id, l.locality);
      for (const l of sameName.filter((x) => x.normalizedName === keyById.get(n.nodeId))) seen.set(l.id, l);
    }
    o.likelyAreas = [...seen.values()].slice(0, 8).map((l) => ({ id: l.id, canonicalName: l.canonicalName, lat: l.lat ?? null, lon: l.lon ?? null }));
  }
  return outages;
}

/** Adds likely areas, the latest one-line update and (for planned work) the scheduled date to a list of outages. */
async function decorate(outages) {
  if (!outages.length) return outages;
  await withLikelyAreas(outages);
  const ids = outages.map((o) => o.id);
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (op."outageId") op."outageId" AS "outageId", op."postedAt" AS "postedAt", sp."createdAt" AS "ingestedAt", sp."externalId" AS "externalId", ps."summary" AS "summary"
    FROM "OutagePost" op
    JOIN "SourcePost" sp ON sp."id" = op."postId"
    LEFT JOIN "PostSummary" ps ON ps."postId" = op."postId" AND ps."faultIndex" = op."faultIndex"
    WHERE op."outageId" IN (${Prisma.join(ids)})
    ORDER BY op."outageId", op."postedAt" DESC`;
  const latest = new Map(rows.map((r) => [r.outageId, r]));

  const plannedIds = outages.filter((o) => o.kind === 'PLANNED').map((o) => o.id);
  const schedule = new Map();
  if (plannedIds.length) {
    const posts = await prisma.outagePost.findMany({
      where: { outageId: { in: plannedIds } },
      orderBy: { postedAt: 'desc' },
      include: { post: { select: { text: true, noteTweetText: true, publishedAt: true } } },
    });
    for (const p of posts) {
      if (schedule.has(p.outageId)) continue;
      const s = parseSchedule(p.post.noteTweetText || p.post.text, p.post.publishedAt);
      if (s) schedule.set(p.outageId, s);
    }
  }
  for (const o of outages) {
    const l = latest.get(o.id);
    o.latest = l ? { summary: l.summary, at: l.postedAt, ingestedAt: l.ingestedAt, url: `https://x.com/CityPowerJhb/status/${l.externalId}` } : null;
    o.scheduled = schedule.get(o.id) ?? null;
  }
  return outages;
}

const shapeOutage = (o) => ({
  id: o.id,
  title: o.title,
  kind: o.kind,
  status: o.status,
  sdc: o.sdcName,
  cause: o.cause,
  eta: o.etaText,
  restorationPercent: o.restorationPercent,
  startedAt: o.startedAt,
  lastUpdateAt: o.lastUpdateAt,
  restoredAt: o.restoredAt,
  retroactive: o.retroactive,
  postCount: o._count?.posts ?? null,
  latest: o.latest ?? null,
  scheduled: o.scheduled ?? null,
  infrastructure: o.nodes?.map((n) => n.node),
  localities: o.localities?.map((l) => ({ ...l.locality, restored: l.restored })),
  likelyAreas: o.likelyAreas ?? [],
});

const shapeMany = async (rows) => (await decorate(rows)).map(shapeOutage);

router.get('/health', wrap(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true });
}));

// ───────────── outages ─────────────

router.get('/v1/outages', wrap(async (req, res) => {
  const { status, sdc, suburb, region, q, sort = 'updated', limit = '50', offset = '0' } = req.query;
  const and = [{ status: { in: status ? String(status).split(',') : ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED'] } }];
  if (sdc) and.push({ sdcName: { equals: String(sdc), mode: 'insensitive' } });
  const locality = {};
  if (suburb) locality.normalizedName = { contains: localityKey(suburb) };
  if (region) locality.Region = { code: String(region).toUpperCase() };
  if (Object.keys(locality).length) and.push({ localities: { some: { locality } } });
  if (q && String(q).trim()) {
    const k = String(q).trim();
    and.push({
      OR: [
        { title: { contains: k, mode: 'insensitive' } },
        { localities: { some: { locality: { canonicalName: { contains: k, mode: 'insensitive' } } } } },
        { nodes: { some: { node: { name: { contains: k, mode: 'insensitive' } } } } },
      ],
    });
  }
  const where = { AND: and };
  const orderBy = sort === 'started' ? { startedAt: 'desc' } : sort === 'name' ? { title: 'asc' } : { lastUpdateAt: 'desc' };
  const [total, rows] = await Promise.all([
    prisma.outage.count({ where }),
    prisma.outage.findMany({ where, include: outageInclude, orderBy, take: Math.min(Number(limit) || 50, 100), skip: Number(offset) || 0 }),
  ]);
  res.json({ data: await shapeMany(rows), total });
}));

router.get('/v1/outages/:id', wrap(async (req, res) => {
  const outage = await prisma.outage.findUnique({
    where: { id: req.params.id },
    include: { ...outageInclude, posts: { orderBy: { postedAt: 'asc' }, include: { post: { select: { externalId: true, text: true, noteTweetText: true, publishedAt: true, PostMedia: { select: { url: true } }, extractions: { select: { imageText: true } } } } } } },
  });
  if (!outage) return res.status(404).json({ error: 'not_found' });
  await decorate([outage]);
  const summaries = new Map((await prisma.postSummary.findMany({ where: { postId: { in: outage.posts.map((p) => p.postId) } } })).map((s) => [`${s.postId}|${s.faultIndex}`, s.summary]));
  const sdcNode = outage.sdcName ? await prisma.infraNode.findFirst({ where: { type: 'SDC', name: outage.sdcName }, select: { id: true, name: true } }) : null;
  res.json({
    ...shapeOutage(outage),
    sdcNode,
    timeline: outage.posts.map((p) => ({
      role: p.role,
      summary: summaries.get(`${p.postId}|${p.faultIndex}`) ?? null,
      postedAt: p.postedAt,
      score: p.score,
      reasons: p.reasons,
      url: `https://x.com/CityPowerJhb/status/${p.post.externalId}`,
      text: p.post.noteTweetText || p.post.text,
      imageText: p.post.extractions[0]?.imageText ?? null,
      images: p.post.PostMedia.map((m) => m.url),
    })),
  });
}));

// ───────────── overview (the home page in one call) ─────────────

router.get('/v1/overview', wrap(async (_req, res) => {
  const now = new Date();
  const [byStatus, liveRows, bySdcRows, dailyRows, restored24, lastPost, updates, plannedRows] = await Promise.all([
    prisma.outage.groupBy({ by: ['status'], _count: true }),
    prisma.outage.findMany({ where: { status: { in: LIVE } }, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: 8 }),
    prisma.outage.groupBy({ by: ['sdcName', 'status'], where: { status: { in: [...LIVE, 'PLANNED'] } }, _count: true }),
    prisma.$queryRaw`
      SELECT to_char((("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM "Outage" WHERE kind = 'UNPLANNED' AND "startedAt" >= (now() AT TIME ZONE 'UTC') - interval '16 days' GROUP BY 1 ORDER BY 1`,
    prisma.outage.count({ where: { status: { in: ['RESTORED', 'CLOSED'] }, restoredAt: { gte: new Date(now - 24 * HOUR) } } }),
    prisma.sourcePost.aggregate({ _max: { publishedAt: true } }),
    prisma.$queryRaw`
      SELECT op."outageId" AS "outageId", op."postedAt" AS "postedAt", sp."createdAt" AS "ingestedAt", op."role"::text AS "role", ps."summary" AS "summary",
             o."title" AS "title", o."status"::text AS "status", o."sdcName" AS "sdc", sp."externalId" AS "externalId"
      FROM "OutagePost" op
      JOIN "Outage" o ON o."id" = op."outageId"
      JOIN "SourcePost" sp ON sp."id" = op."postId"
      LEFT JOIN "PostSummary" ps ON ps."postId" = op."postId" AND ps."faultIndex" = op."faultIndex"
      ORDER BY op."postedAt" DESC LIMIT 60`,
    prisma.outage.findMany({ where: { status: 'PLANNED' }, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: 60 }),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));
  const sdcMap = new Map();
  for (const r of bySdcRows) {
    if (!r.sdcName) continue;
    const e = sdcMap.get(r.sdcName) ?? { sdc: r.sdcName, live: 0, partial: 0, planned: 0 };
    if (r.status === 'ACTIVE') e.live += r._count;
    else if (r.status === 'PARTIALLY_RESTORED') e.partial += r._count;
    else e.planned += r._count;
    sdcMap.set(r.sdcName, e);
  }

  // last 10 days, zero-filled, in Johannesburg time
  const dayCount = new Map(dailyRows.map((r) => [r.day, r.n]));
  const daily = [];
  for (let i = 9; i >= 0; i--) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date(now - i * 24 * HOUR));
    daily.push({ date, count: dayCount.get(date) ?? 0 });
  }

  const planned = await shapeMany(plannedRows);
  const today = todaySAST();
  const upcoming = planned
    .filter((o) => !o.scheduled || o.scheduled.date >= today)
    .sort((a, b) => (a.scheduled?.date ?? '9999').localeCompare(b.scheduled?.date ?? '9999'));

  res.json({
    asOf: now,
    lastPostAt: lastPost._max.publishedAt,
    counts: {
      live: counts.ACTIVE ?? 0,
      partial: counts.PARTIALLY_RESTORED ?? 0,
      restored24h: restored24,
      plannedUpcoming: upcoming.length,
      stale: counts.STALE ?? 0,
    },
    live: await shapeMany(liveRows),
    latestUpdates: [...new Map(updates.map((u) => [u.outageId, u])).values()].slice(0, 8),
    bySdc: [...sdcMap.values()].sort((a, b) => b.live + b.partial - (a.live + a.partial) || a.sdc.localeCompare(b.sdc)),
    daily,
    planned: upcoming.slice(0, 6),
  });
}));

// ───────────── search ─────────────

router.get('/v1/search', wrap(async (req, res) => {
  const raw = String(req.query.q ?? '').trim();
  const k = localityKey(raw);
  if (k.length < 2) return res.json({ suburbs: [], equipment: [], outages: [] });
  const [suburbs, equipment, outages] = await Promise.all([
    prisma.locality.findMany({ where: { normalizedName: { contains: k } }, include: { Region: true }, take: 40 }),
    prisma.infraNode.findMany({ where: { type: { not: 'SDC' }, normalizedKey: { contains: k } }, orderBy: { evidenceCount: 'desc' }, take: 5 }),
    prisma.outage.findMany({ where: { title: { contains: raw, mode: 'insensitive' } }, orderBy: { lastUpdateAt: 'desc' }, take: 5, select: { id: true, title: true, status: true, sdcName: true } }),
  ]);
  const rank = (l) => (l.normalizedName === k ? 0 : l.normalizedName.startsWith(k) ? 1 : 2);
  suburbs.sort((a, b) => rank(a) - rank(b) || a.canonicalName.length - b.canonicalName.length);
  res.json({
    suburbs: suburbs.slice(0, 7).map((l) => ({ id: l.id, name: l.canonicalName, region: l.Region?.code ?? null, lat: l.lat ?? null, lon: l.lon ?? null })),
    equipment: equipment.map((n) => ({ id: n.id, name: n.name, type: n.type })),
    outages: outages.map((o) => ({ id: o.id, title: o.title, status: o.status, sdc: o.sdcName })),
  });
}));

// ───────────── suburbs ─────────────

router.get('/v1/localities', wrap(async (req, res) => {
  const q = localityKey(req.query.q ?? '');
  if (q.length < 2) return res.json({ data: [] });
  const rows = await prisma.locality.findMany({ where: { normalizedName: { contains: q } }, include: { Region: true }, take: 20 });
  res.json({ data: rows.map((l) => ({ id: l.id, name: l.canonicalName, region: l.Region?.code ?? null })) });
}));

router.get('/v1/localities/:id', wrap(async (req, res) => {
  const l = await prisma.locality.findUnique({ where: { id: req.params.id }, include: { Region: true, nodes: { include: { node: true }, orderBy: { evidenceCount: 'desc' }, take: 20 } } });
  if (!l) return res.status(404).json({ error: 'not_found' });
  res.json({ id: l.id, name: l.canonicalName, region: l.Region?.code ?? null, learned: l.sourceLabel === 'learned-from-posts', infrastructure: l.nodes.map((n) => ({ ...n.node, evidenceCount: n.evidenceCount })) });
}));

router.get('/v1/localities/:id/outages', wrap(async (req, res) => {
  const outages = await prisma.outage.findMany({
    where: { localities: { some: { localityId: req.params.id } } },
    include: outageInclude,
    orderBy: { lastUpdateAt: 'desc' },
    take: 50,
  });
  // outages whose posts named no suburb but whose equipment is known to serve this one
  const loc = await prisma.locality.findUnique({ where: { id: req.params.id }, select: { normalizedName: true } });
  const possible = await prisma.outage.findMany({
    where: {
      localities: { none: {} },
      status: { in: ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED', 'STALE'] },
      nodes: { some: { node: { OR: [{ localities: { some: { localityId: req.params.id, evidenceCount: { gte: 3 } } } }, { normalizedKey: loc?.normalizedName ?? '__no_match__' }] } } },
    },
    include: outageInclude,
    orderBy: { lastUpdateAt: 'desc' },
    take: 20,
  });
  res.json({ data: await shapeMany(outages), possible: await shapeMany(possible) });
}));

// ───────────── network (equipment) ─────────────

router.get('/v1/network/sdcs', wrap(async (_req, res) => {
  const sdcs = await prisma.infraNode.findMany({ where: { type: 'SDC' }, orderBy: { name: 'asc' } });
  const [edgeCounts, outageRows] = await Promise.all([
    prisma.infraEdge.groupBy({ by: ['parentId'], where: { parentId: { in: sdcs.map((s) => s.id) } }, _count: true }),
    prisma.outage.groupBy({ by: ['sdcName', 'status'], where: { status: { in: [...LIVE, 'PLANNED'] } }, _count: true }),
  ]);
  const kids = new Map(edgeCounts.map((e) => [e.parentId, e._count]));
  res.json({
    data: sdcs.map((s) => {
      const mine = outageRows.filter((r) => r.sdcName === s.name);
      const n = (st) => mine.filter((r) => r.status === st).reduce((a, r) => a + r._count, 0);
      return { id: s.id, name: s.name, equipment: kids.get(s.id) ?? 0, live: n('ACTIVE'), partial: n('PARTIALLY_RESTORED'), planned: n('PLANNED'), lastSeenAt: s.lastSeenAt };
    }),
  });
}));

// ───────────── map ─────────────

const place = (l, extra = {}) => ({ id: l.id, name: l.canonicalName, lat: l.lat, lon: l.lon, ...extra });

/** Live outages with the approximate position of each affected suburb. Suburbs we could not place are only counted. */
router.get('/v1/map', wrap(async (_req, res) => {
  const rows = await prisma.outage.findMany({ where: { status: { in: LIVE } }, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: 100 });
  const outages = await shapeMany(rows);
  res.json({
    data: outages.map((o) => {
      const named = o.localities.map((l) => place(l, { restored: l.restored, inferred: false }));
      const all = named.length ? named : o.likelyAreas.map((l) => place({ ...l, canonicalName: l.canonicalName }, { restored: false, inferred: true }));
      return {
        id: o.id, title: o.title, status: o.status, restorationPercent: o.restorationPercent, sdc: o.sdc, lastUpdateAt: o.lastUpdateAt, latest: o.latest?.summary ?? null,
        equipment: (o.infrastructure ?? []).filter((n) => ['SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR'].includes(n.type)).map((n) => ({ id: n.id, name: n.name, type: n.type })),
        places: all.filter((p) => p.lat != null && p.lon != null),
        unplaced: all.filter((p) => p.lat == null || p.lon == null).length,
      };
    }),
  });
}));

/** Suburb outlines (Stats SA Census 2011 sub-places) for every suburb in use, as GeoJSON. Coloured by the page from the live outages. */
router.get('/v1/map/regions', wrap(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(await regionsGeoJson());
}));

/** Every substation, switching station and distributor with a known area, at its inferred position. */
router.get('/v1/map/infrastructure', wrap(async (_req, res) => {
  res.json({ data: await equipmentHubs() });
}));

/** The suburbs a piece of equipment is known to reach, including everything downstream of it. Approximate: it is what posts have named. */
router.get('/v1/map/node/:id', wrap(async (req, res) => {
  const root = await prisma.infraNode.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, type: true } });
  if (!root) return res.status(404).json({ error: 'not_found' });
  const ids = new Set([root.id]);
  let frontier = [root.id];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const edges = await prisma.infraEdge.findMany({ where: { parentId: { in: frontier } }, select: { childId: true } });
    frontier = edges.map((e) => e.childId).filter((c) => !ids.has(c));
    frontier.forEach((c) => ids.add(c));
  }
  const rows = await prisma.nodeLocality.findMany({ where: { nodeId: { in: [...ids] } }, include: { locality: { select: { id: true, canonicalName: true, lat: true, lon: true } } } });
  const byLoc = new Map();
  for (const r of rows) {
    const cur = byLoc.get(r.localityId) ?? { ...r.locality, evidence: 0 };
    cur.evidence += r.evidenceCount;
    byLoc.set(r.localityId, cur);
  }
  const all = [...byLoc.values()].sort((a, b) => b.evidence - a.evidence);
  const liveRows = await prisma.outageNode.findMany({ where: { nodeId: { in: [...ids] }, outage: { status: { in: LIVE } } }, select: { outage: { select: { localities: { select: { localityId: true } } } } } });
  const affected = new Set(liveRows.flatMap((r) => r.outage.localities.map((l) => l.localityId)));
  const placed = all.filter((l) => l.lat != null).slice(0, 120).map((l) => place(l, { evidence: l.evidence, live: affected.has(l.id) }));
  const flow = await equipmentFlow(root.id, placed);
  res.json({
    node: root,
    places: placed,
    origin: flow.origin,
    children: flow.children.map((c) => ({ id: c.id, name: c.name, type: c.type, lon: c.lon, lat: c.lat, live: c.live, served: c.served, near: c.near })),
    edges: flow.edges,
    unplaced: all.filter((l) => l.lat == null).length,
    total: all.length,
  });
}));

router.get('/v1/infrastructure/:id', wrap(async (req, res) => {
  const node = await prisma.infraNode.findUnique({
    where: { id: req.params.id },
    include: {
      parents: { include: { parent: true } },
      children: { include: { child: true }, orderBy: { evidenceCount: 'desc' } },
      localities: { include: { locality: true }, orderBy: { evidenceCount: 'desc' }, take: 50 },
      aliases: true,
    },
  });
  if (!node) return res.status(404).json({ error: 'not_found' });

  const chain = [];
  let cur = node;
  for (let i = 0; i < 4; i++) {
    const e = await prisma.infraEdge.findFirst({ where: { childId: cur.id }, orderBy: { evidenceCount: 'desc' }, include: { parent: true } });
    if (!e) break;
    chain.unshift(e.parent);
    cur = e.parent;
  }
  const childIds = node.children.map((c) => c.childId);
  const liveRows = childIds.length ? await prisma.outageNode.findMany({ where: { nodeId: { in: childIds }, outage: { status: { in: LIVE } } }, select: { nodeId: true } }) : [];
  const liveIds = new Set(liveRows.map((r) => r.nodeId));
  // an SDC is not stored on outages as equipment; its outages are the ones reported under its name
  const recent = await prisma.outage.findMany({
    where: node.type === 'SDC' ? { sdcName: node.name } : { nodes: { some: { nodeId: node.id } } },
    include: outageInclude,
    orderBy: { lastUpdateAt: 'desc' },
    take: 8,
  });
  res.json({
    ...node,
    chain,
    children: node.children.map((c) => ({ ...c, child: { ...c.child, live: liveIds.has(c.childId) } })),
    recentOutages: await shapeMany(recent),
  });
}));

router.get('/v1/infrastructure', wrap(async (req, res) => {
  const { type, q } = req.query;
  const nodes = await prisma.infraNode.findMany({
    where: { type: type ? String(type).toUpperCase() : { not: 'SDC' }, ...(q ? { normalizedKey: { contains: localityKey(q) } } : {}) },
    orderBy: { evidenceCount: 'desc' },
    take: 100,
  });
  const liveRows = nodes.length ? await prisma.outageNode.findMany({ where: { nodeId: { in: nodes.map((n) => n.id) }, outage: { status: { in: LIVE } } }, select: { nodeId: true } }) : [];
  const liveIds = new Set(liveRows.map((r) => r.nodeId));
  res.json({ data: nodes.map((n) => ({ ...n, live: liveIds.has(n.id) })) });
}));

// ───────────── manual refresh (fetch latest posts, read them, update outages) ─────────────

const refreshEnabled = () => env.REFRESH_BUTTON === 'on';

router.get('/v1/refresh', wrap(async (_req, res) => {
  const lastBatch = await prisma.ingestionRun.findFirst({
    where: { postsInserted: { gt: 0 } },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true, completedAt: true, postsInserted: true },
  });
  res.json({ enabled: refreshEnabled(), ...cycle.status(), lastBatch });
}));

/**
 * What changed since a moment in time: outages that were opened or got updates, with each update's one-line
 * summary, plus how many posts were read and how many were not outage-related (customer replies, notices).
 */
router.get('/v1/changes', wrap(async (req, res) => {
  const parsed = new Date(String(req.query.since ?? ''));
  const since = Number.isNaN(parsed.getTime()) ? new Date(Date.now() - 24 * HOUR) : parsed;
  const rows = await prisma.$queryRaw`
    SELECT ld."outageId" AS "outageId", ld."faultIndex" AS "faultIndex",
           o."title" AS "title", o."status"::text AS "status", o."sdcName" AS "sdc", o."kind"::text AS "kind", o."createdAt" AS "outageCreatedAt",
           op."role"::text AS "role", sp."externalId" AS "externalId", sp."publishedAt" AS "postedAt", ps."summary" AS "summary"
    FROM "LinkDecision" ld
    JOIN "Outage" o ON o."id" = ld."outageId"
    JOIN "SourcePost" sp ON sp."id" = ld."postId"
    LEFT JOIN "OutagePost" op ON op."outageId" = ld."outageId" AND op."postId" = ld."postId"
    LEFT JOIN "PostSummary" ps ON ps."postId" = ld."postId" AND ps."faultIndex" = ld."faultIndex"
    WHERE ld."createdAt" >= ${since.toISOString()}::timestamp AND ld."outageId" IS NOT NULL
    ORDER BY sp."publishedAt" ASC`;

  const byOutage = new Map();
  for (const r of rows) {
    const o = byOutage.get(r.outageId) ?? { id: r.outageId, title: r.title, status: r.status, sdc: r.sdc, kind: r.kind, isNew: r.outageCreatedAt >= since, updates: [] };
    o.updates.push({ postedAt: r.postedAt, role: r.role, summary: r.summary, url: `https://x.com/CityPowerJhb/status/${r.externalId}` });
    byOutage.set(r.outageId, o);
  }
  const outages = [...byOutage.values()].sort((a, b) => b.updates.at(-1).postedAt - a.updates.at(-1).postedAt);

  const [newPosts, replies, notices, needsReview] = await Promise.all([
    prisma.sourcePost.count({ where: { createdAt: { gte: since } } }),
    prisma.linkDecision.count({ where: { createdAt: { gte: since }, reason: { startsWith: 'customer reply' } } }),
    prisma.linkDecision.count({ where: { createdAt: { gte: since }, reason: { startsWith: 'not linkable' } } }),
    prisma.linkDecision.count({ where: { createdAt: { gte: since }, outcome: 'NEEDS_REVIEW' } }),
  ]);
  res.json({ since, counts: { newPosts, replies, notices, needsReview, outagesNew: outages.filter((o) => o.isNew).length, outagesUpdated: outages.filter((o) => !o.isNew).length }, outages });
}));

router.post('/v1/refresh', wrap(async (req, res) => {
  if (!refreshEnabled()) return res.status(403).json({ enabled: false, error: 'Manual refresh is switched off.' });
  if (env.REFRESH_TOKEN && req.get('x-refresh-token') !== env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not allowed.' });
  const r = cycle.start('manual');
  res.status(r.started ? 202 : r.reason === 'cooldown' ? 429 : 409).json({ enabled: true, ...r });
}));

// ───────────── admin ─────────────

router.post('/admin/ingest', wrap(async (_req, res) => res.json(await ingestNewPosts())));
router.post('/admin/process', wrap(async (_req, res) => res.json(await processPending())));
router.post('/admin/reprocess/:postId', wrap(async (req, res) => {
  await prisma.linkDecision.deleteMany({ where: { postId: req.params.postId } });
  res.json(await processPost(req.params.postId));
}));
router.get('/admin/review-queue', wrap(async (_req, res) => {
  const posts = await prisma.sourcePost.findMany({
    where: { processingStatus: { in: ['NEEDS_REVIEW', 'PROCESSING_ERROR'] } },
    orderBy: { publishedAt: 'desc' },
    take: 100,
    select: { id: true, externalId: true, text: true, publishedAt: true, processingStatus: true, linkDecisions: true, extractions: { select: { status: true, error: true } } },
  });
  res.json({ data: posts });
}));

router.get('/v1/stats', wrap(async (_req, res) => {
  const [byStatus, sdcs, nodes, localities, posts, latest] = await Promise.all([
    prisma.outage.groupBy({ by: ['status'], _count: true }),
    prisma.outage.groupBy({ by: ['sdcName'], where: { status: { in: ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED'] } }, _count: true }),
    prisma.infraNode.count(),
    prisma.locality.count(),
    prisma.sourcePost.count(),
    prisma.sourcePost.aggregate({ _max: { publishedAt: true } }),
  ]);
  res.json({
    outagesByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
    activeBySdc: sdcs.filter((s) => s.sdcName).map((s) => ({ sdc: s.sdcName, count: s._count })),
    infrastructureNodes: nodes,
    localities,
    posts,
    lastPostAt: latest._max.publishedAt,
  });
}));
