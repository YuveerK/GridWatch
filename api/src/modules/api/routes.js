import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { localityKey } from '../../lib/normalize.js';
import { z } from 'zod';
import { ingestNewPosts } from '../ingestion/ingestion.service.js';
import { env } from '../../config/env.js';
import { cycle } from '../processing/cycle.js';
import { scheduleState } from '../processing/schedule-state.js';
import { processPending, reprocessPost } from '../processing/processor.service.js';
import { authorize, checkToken, isSameOrigin, allowedOrigins, loginAllowed, recordLoginFailure, requireOperator, resetLoginFailures, sessionCookie } from './operator-auth.js';
import { equipmentFlow, equipmentHubs } from '../geo/equipment-map.service.js';
import { insights } from './insights.service.js';
import { latestUpdates } from './updates.service.js';
import { localityHistory } from './locality-history.service.js';

export const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const LIVE = ['ACTIVE', 'PARTIALLY_RESTORED'];
const HOUR = 3_600_000;

/** Parse a request's query/body against a schema; a bad request is answered with 400 and says what was wrong. */
const parse = (schema, input, res) => {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  res.status(400).json({ error: 'invalid_request', details: r.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), message: i.message })) });
  return null;
};
const intParam = (min, max, dflt) => z.preprocess((v) => (v === undefined || v === '' ? dflt : v), z.coerce.number().int().min(min).max(max));
const STATUSES = ['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'PLANNED', 'STALE', 'CLOSED', 'CANCELLED'];
const text = (max) => z.string().trim().max(max);
const id = z.string().trim().min(1).max(64);

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

const SAST_MS = 2 * HOUR;
/** The announced window of planned work, in Johannesburg time, from the stored UTC instants (null when never announced). */
function scheduleView(o) {
  if (o.kind !== 'PLANNED' || !o.scheduledStart || !o.scheduledEnd) return null;
  const local = (d) => new Date(d.getTime() + SAST_MS).toISOString();
  const start = local(o.scheduledStart);
  const end = local(o.scheduledEnd);
  const allDay = start.slice(11, 16) === '00:00' && end.slice(11, 16) === '00:00' && (o.scheduledEnd - o.scheduledStart) % (24 * HOUR) === 0;
  return { date: start.slice(0, 10), from: allDay ? null : start.slice(11, 16), to: allDay ? null : end.slice(11, 16), start: o.scheduledStart, end: o.scheduledEnd };
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

  for (const o of outages) {
    const l = latest.get(o.id);
    o.latest = l ? { summary: l.summary, at: l.postedAt, ingestedAt: l.ingestedAt, url: `https://x.com/CityPowerJhb/status/${l.externalId}` } : null;
    o.scheduled = scheduleView(o);
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
  const query = parse(
    z.object({
      status: z.string().optional().transform((v) => (v ? v.split(',').map((x) => x.trim()) : undefined)).pipe(z.array(z.enum(STATUSES)).max(STATUSES.length).optional()),
      sdc: text(80).optional(),
      suburb: text(80).optional(),
      region: text(4).optional(),
      q: text(80).optional(),
      sort: z.enum(['updated', 'started', 'name']).default('updated'),
      limit: intParam(1, 100, 50),
      offset: intParam(0, 10_000, 0),
    }),
    req.query,
    res,
  );
  if (!query) return;
  const { status, sdc, suburb, region, q, sort, limit, offset } = query;
  const and = [{ status: { in: status ?? ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED'] } }];
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
  // every order ends in the id so paging is stable when timestamps tie
  const orderBy = sort === 'started' ? [{ startedAt: 'desc' }, { id: 'asc' }] : sort === 'name' ? [{ title: 'asc' }, { id: 'asc' }] : [{ lastUpdateAt: 'desc' }, { id: 'asc' }];
  const [total, rows] = await Promise.all([
    prisma.outage.count({ where }),
    prisma.outage.findMany({ where, include: outageInclude, orderBy, take: limit, skip: offset }),
  ]);
  res.json({ data: await shapeMany(rows), total });
}));

router.get('/v1/outages/:id', wrap(async (req, res) => {
  if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_request' });
  const outage = await prisma.outage.findUnique({
    where: { id: req.params.id },
    include: { ...outageInclude, posts: { orderBy: [{ postedAt: 'asc' }, { faultIndex: 'asc' }, { postId: 'asc' }], include: { post: { select: { externalId: true, text: true, noteTweetText: true, publishedAt: true, PostMedia: { select: { url: true } }, extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { imageText: true } } } } } } },
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
  const [byStatus, liveRows, bySdcRows, dailyRows, restored24, lastPost, updates, plannedRows, plannedTotal, sdcDailyRows] = await Promise.all([
    prisma.outage.groupBy({ by: ['status'], _count: true }),
    prisma.outage.findMany({ where: { status: { in: LIVE } }, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: 8 }),
    prisma.outage.groupBy({ by: ['sdcName', 'status'], where: { status: { in: [...LIVE, 'PLANNED'] } }, _count: true }),
    prisma.$queryRaw`
      SELECT to_char((("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM "Outage" WHERE kind = 'UNPLANNED' AND "startedAt" >= (now() AT TIME ZONE 'UTC') - interval '16 days' GROUP BY 1 ORDER BY 1`,
    prisma.outage.count({ where: { status: { in: ['RESTORED', 'CLOSED'] }, restoredAt: { gte: new Date(now - 24 * HOUR) } } }),
    prisma.sourcePost.aggregate({ _max: { publishedAt: true } }),
    prisma.$queryRaw`
      SELECT * FROM (
        SELECT DISTINCT ON (op."outageId") op."outageId" AS "outageId", op."postedAt" AS "postedAt", sp."createdAt" AS "ingestedAt", op."role"::text AS "role", ps."summary" AS "summary",
               o."title" AS "title", o."status"::text AS "status", o."sdcName" AS "sdc", sp."externalId" AS "externalId"
        FROM "OutagePost" op
        JOIN "Outage" o ON o."id" = op."outageId"
        JOIN "SourcePost" sp ON sp."id" = op."postId"
        LEFT JOIN "PostSummary" ps ON ps."postId" = op."postId" AND ps."faultIndex" = op."faultIndex"
        ORDER BY op."outageId", op."postedAt" DESC, op."faultIndex" DESC, op."postId" DESC
      ) latest ORDER BY "postedAt" DESC, "outageId" LIMIT 8`,
    // announced work that has not finished, soonest first; an outage whose window is unknown stays in until the sweep closes it
    prisma.outage.findMany({ where: { status: 'PLANNED', OR: [{ scheduledEnd: null }, { scheduledEnd: { gte: now } }] }, include: outageInclude, orderBy: [{ scheduledStart: { sort: 'asc', nulls: 'last' } }, { lastUpdateAt: 'desc' }, { id: 'asc' }], take: 60 }),
    prisma.outage.count({ where: { status: 'PLANNED', OR: [{ scheduledEnd: null }, { scheduledEnd: { gte: now } }] } }),
    // unplanned outages that started each day (Johannesburg time), per service centre: the history strips
    prisma.$queryRaw`
      SELECT "sdcName" AS sdc, to_char((("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
      FROM "Outage" WHERE kind = 'UNPLANNED' AND "sdcName" IS NOT NULL AND "startedAt" >= (now() AT TIME ZONE 'UTC') - interval '15 days'
      GROUP BY 1, 2`,
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

  // last 14 days per service centre, oldest first, zero-filled
  const days14 = Array.from({ length: 14 }, (_, k) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date(now - (13 - k) * 24 * HOUR)));
  const bySdcDay = new Map();
  for (const r of sdcDailyRows) bySdcDay.set(`${r.sdc}|${r.day}`, r.n);
  const sdcNames = [...new Set(sdcDailyRows.map((r) => r.sdc))].sort();
  const history = sdcNames.map((sdc) => ({ sdc, days: days14.map((date) => ({ date, count: bySdcDay.get(`${sdc}|${date}`) ?? 0 })) }));

  const planned = await shapeMany(plannedRows);
  const upcoming = planned
    .filter((o) => (o.scheduled ? new Date(o.scheduled.end) >= now : true))
    .sort((a, b) => (a.scheduled?.date ?? '9999').localeCompare(b.scheduled?.date ?? '9999') || a.id.localeCompare(b.id));

  res.json({
    asOf: now,
    lastPostAt: lastPost._max.publishedAt,
    counts: {
      live: counts.ACTIVE ?? 0,
      partial: counts.PARTIALLY_RESTORED ?? 0,
      restored24h: restored24,
      plannedUpcoming: plannedTotal, // exact, not limited to the rows shown
      stale: counts.STALE ?? 0,
    },
    live: await shapeMany(liveRows),
    latestUpdates: updates,
    bySdc: [...sdcMap.values()].sort((a, b) => b.live + b.partial - (a.live + a.partial) || a.sdc.localeCompare(b.sdc)),
    daily,
    history,
    planned: upcoming.slice(0, 6),
  });
}));

// ───────────── search ─────────────

router.get('/v1/search', wrap(async (req, res) => {
  const q = parse(z.object({ q: text(80).default('') }), req.query, res);
  if (!q) return;
  const raw = q.q;
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
  const parsed = parse(z.object({ q: text(80).default('') }), req.query, res);
  if (!parsed) return;
  const q = localityKey(parsed.q);
  if (q.length < 2) return res.json({ data: [] });
  const rows = await prisma.locality.findMany({ where: { normalizedName: { contains: q } }, include: { Region: true }, take: 20 });
  res.json({ data: rows.map((l) => ({ id: l.id, name: l.canonicalName, region: l.Region?.code ?? null })) });
}));

router.get('/v1/localities/:id', wrap(async (req, res) => {
  if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_request' });
  const l = await prisma.locality.findUnique({ where: { id: req.params.id }, include: { Region: true, nodes: { include: { node: true }, orderBy: { evidenceCount: 'desc' }, take: 20 } } });
  if (!l) return res.status(404).json({ error: 'not_found' });
  res.json({ id: l.id, name: l.canonicalName, region: l.Region?.code ?? null, learned: l.sourceLabel === 'learned-from-posts', infrastructure: l.nodes.map((n) => ({ ...n.node, evidenceCount: n.evidenceCount })) });
}));

router.get('/v1/localities/:id/outages', wrap(async (req, res) => {
  if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_request' });
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

/** A suburb's outage history and what is typical for it (how long power takes to come back, the usual cause, repeat equipment). */
router.get('/v1/localities/:id/history', wrap(async (req, res) => {
  if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_request' });
  const q = parse(z.object({ days: intParam(1, 365, 90) }), req.query, res);
  if (!q) return;
  if (!(await prisma.locality.findUnique({ where: { id: req.params.id }, select: { id: true } }))) return res.status(404).json({ error: 'not_found' });
  res.json(await localityHistory({ localityId: req.params.id, days: q.days }));
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

/** localityId -> 'out' | 'restored' for suburbs named by currently live outages. Suburbs no live outage mentions are absent. */
async function localityStates(localityIds) {
  const out = new Map();
  if (!localityIds.length) return out;
  const rows = await prisma.outageLocality.findMany({ where: { localityId: { in: localityIds }, outage: { status: { in: LIVE } } }, select: { localityId: true, restored: true } });
  for (const r of rows) {
    if (!r.restored) out.set(r.localityId, 'out');
    else if (!out.has(r.localityId)) out.set(r.localityId, 'restored');
  }
  return out;
}

/** Live outages with the approximate position of each affected suburb. Suburbs we could not place are only counted. */
router.get('/v1/map', wrap(async (_req, res) => {
  const rows = await prisma.outage.findMany({ where: { status: { in: LIVE } }, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: 100 });
  const outages = await shapeMany(rows);
  res.json({
    data: outages.map((o) => {
      const named = o.localities.map((l) => place(l, { restored: l.restored, inferred: false }));
      const all = named.length ? named : o.likelyAreas.map((l) => place({ ...l, canonicalName: l.canonicalName }, { restored: false, inferred: true }));
      return {
        id: o.id, title: o.title, status: o.status, restorationPercent: o.restorationPercent, sdc: o.sdc, startedAt: o.startedAt, lastUpdateAt: o.lastUpdateAt, latest: o.latest?.summary ?? null, latestIngestedAt: o.latest?.ingestedAt ?? null,
        equipment: (o.infrastructure ?? []).filter((n) => ['SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR'].includes(n.type)).map((n) => ({ id: n.id, name: n.name, type: n.type })),
        places: all.filter((p) => p.lat != null && p.lon != null),
        unplaced: all.filter((p) => p.lat == null || p.lon == null).length,
      };
    }),
  });
}));

/** Every substation, switching station and distributor with a known area, at its inferred position. */
router.get('/v1/map/infrastructure', wrap(async (_req, res) => {
  res.json({ data: await equipmentHubs() });
}));

/** The suburbs a piece of equipment is known to reach, including everything downstream of it. Approximate: it is what posts have named. */
router.get('/v1/map/node/:id', wrap(async (req, res) => {
  if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_request' });
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
  const placedRows = all.filter((l) => l.lat != null).slice(0, 120);
  // Per suburb, not per outage: a suburb is "out" while ANY live outage (this equipment's or another's) still lists it as
  // not restored; it is "restored" when live outages mention it but all say it is back; otherwise nothing is reported.
  const states = await localityStates(placedRows.map((l) => l.id));
  const placed = placedRows.map((l) => place(l, { evidence: l.evidence, live: states.get(l.id) === 'out', state: states.get(l.id) ?? 'none' }));
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
  if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'invalid_request' });
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
  const query = parse(z.object({ type: z.string().trim().toUpperCase().pipe(z.enum(['SDC', 'SUBSTATION', 'FEEDER', 'DISTRIBUTOR', 'TRANSFORMER', 'MINI_SUBSTATION', 'CABLE', 'SWITCHING_STATION', 'KIOSK', 'OTHER'])).optional(), q: text(80).optional() }), req.query, res);
  if (!query) return;
  const { type, q } = query;
  const nodes = await prisma.infraNode.findMany({
    where: { type: type ?? { not: 'SDC' }, ...(q ? { normalizedKey: { contains: localityKey(q) } } : {}) },
    orderBy: [{ evidenceCount: 'desc' }, { id: 'asc' }],
    take: 100,
  });
  const liveRows = nodes.length ? await prisma.outageNode.findMany({ where: { nodeId: { in: nodes.map((n) => n.id) }, outage: { status: { in: LIVE } } }, select: { nodeId: true } }) : [];
  const liveIds = new Set(liveRows.map((r) => r.nodeId));
  res.json({ data: nodes.map((n) => ({ ...n, live: liveIds.has(n.id) })) });
}));

// ───────────── manual refresh (fetch latest posts, read them, update outages) ─────────────

const refreshEnabled = () => env.REFRESH_BUTTON === 'on';

/** When the site last checked City Power, and when the automatic check will run again. Public: it is what makes "is this current?" answerable. */
router.get('/v1/sync', wrap(async (_req, res) => {
  const [ok, latest] = await Promise.all([
    prisma.ingestionRun.findFirst({ where: { status: 'SUCCEEDED', completedAt: { not: null } }, orderBy: { completedAt: 'desc' }, select: { completedAt: true } }),
    prisma.ingestionRun.findFirst({ orderBy: { startedAt: 'desc' }, select: { status: true, startedAt: true, completedAt: true } }),
  ]);
  const next = scheduleState.enabled ? scheduleState.nextRunAt() : null;
  res.json({
    now: Date.now(),
    lastSyncAt: ok?.completedAt ?? null,
    latestStatus: latest?.status ?? null, // the most recent attempt, so a run of failures is not hidden behind an old success
    latestAt: latest?.completedAt ?? latest?.startedAt ?? null,
    running: cycle.status().state === 'running',
    automatic: scheduleState.enabled,
    intervalMs: scheduleState.enabled ? scheduleState.intervalMs : null,
    nextRunAt: next,
  });
}));

router.get('/v1/refresh', wrap(async (req, res) => {
  const lastBatch = await prisma.ingestionRun.findFirst({
    where: { postsInserted: { gt: 0 } },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true, completedAt: true, postsInserted: true },
  });
  res.json({ enabled: refreshEnabled(), operator: Boolean(authorize(req)), signInAvailable: Boolean(env.OPERATOR_TOKEN), ...cycle.status(), lastBatch });
}));

/**
 * What changed since a moment in time: outages that were opened or got updates, with each update's one-line
 * summary, plus how many posts were read and how many were not outage-related (customer replies, notices).
 */
const CHANGES_LIMIT = 500;
router.get('/v1/changes', wrap(async (req, res) => {
  const query = parse(z.object({ since: z.string().max(40).optional() }), req.query, res);
  if (!query) return;
  const floor = new Date(Date.now() - 7 * 24 * HOUR); // the window is bounded: a "what changed" view is not an export
  let since = new Date(Date.now() - 24 * HOUR);
  if (query.since !== undefined) {
    since = new Date(query.since);
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'invalid_request', details: [{ field: 'since', message: 'not a valid date-time' }] });
    if (since < floor) since = floor;
  }
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
    ORDER BY sp."publishedAt" ASC, sp."externalId" ASC, ld."faultIndex" ASC
    LIMIT ${CHANGES_LIMIT + 1}`;
  const truncated = rows.length > CHANGES_LIMIT;
  if (truncated) rows.pop();

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
  res.json({ since, truncated, counts: { newPosts, replies, notices, needsReview, outagesNew: outages.filter((o) => o.isNew).length, outagesUpdated: outages.filter((o) => !o.isNew).length }, outages });
}));

router.post('/v1/refresh', requireOperator, wrap(async (_req, res) => {
  if (!refreshEnabled()) return res.status(403).json({ enabled: false, error: 'Manual refresh is switched off.' });
  const r = cycle.start('manual');
  res.status(r.started ? 202 : r.reason === 'cooldown' ? 429 : 409).json({ enabled: true, ...r });
}));

// ───────────── operator sign-in (the refresh button's session) ─────────────

router.get('/v1/operator/session', (req, res) => {
  res.json({ operator: Boolean(authorize(req)), signInAvailable: Boolean(env.OPERATOR_TOKEN) });
});
router.post('/v1/operator/session', (req, res) => {
  if (!isSameOrigin(req) && !allowedOrigins().includes(req.headers.origin)) return res.status(403).json({ error: 'origin_not_allowed' });
  if (!env.OPERATOR_TOKEN) return res.status(501).json({ error: 'operator_sign_in_not_configured' });
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  if (!loginAllowed(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const body = parse(z.object({ token: z.string().max(200) }), req.body ?? {}, res);
  if (!body) return;
  if (!checkToken(body.token)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'wrong_token' });
  }
  resetLoginFailures();
  res.setHeader('Set-Cookie', sessionCookie(req));
  res.json({ operator: true });
});
router.delete('/v1/operator/session', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, true));
  res.json({ operator: false });
});

// ───────────── admin (operator only; each action takes the pipeline lease itself) ─────────────

router.use('/admin', requireOperator);
router.post('/admin/ingest', wrap(async (_req, res) => res.json(await ingestNewPosts())));
router.post('/admin/process', wrap(async (req, res) => {
  const q = parse(z.object({ limit: intParam(0, 1000, env.REFRESH_MAX_POSTS) }), req.query, res);
  if (!q) return;
  res.json(await processPending({ limit: q.limit }));
}));
router.post('/admin/reprocess/:postId', wrap(async (req, res) => {
  if (!id.safeParse(req.params.postId).success) return res.status(400).json({ error: 'invalid_request' });
  const q = parse(z.object({ reextract: z.enum(['true', 'false']).default('false') }), req.query, res);
  if (!q) return;
  const r = await reprocessPost(req.params.postId, { reextract: q.reextract === 'true' });
  res.status(r.outcome === 'NOT_FOUND' ? 404 : r.outcome === 'BUSY' ? 409 : 200).json(r);
}));
router.get('/admin/review-queue', wrap(async (_req, res) => {
  const posts = await prisma.sourcePost.findMany({
    where: { processingStatus: { in: ['NEEDS_REVIEW', 'PROCESSING_ERROR'] } },
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    take: 100,
    select: { id: true, externalId: true, text: true, publishedAt: true, processingStatus: true, linkDecisions: true, extractions: { select: { status: true, error: true } } },
  });
  res.json({ data: posts });
}));

// ───────────── insights: what is causing the outages, and where ─────────────

/** The latest news, not every post: new outages, restorations, progress and new estimates. ?locality= limits it to one suburb. */
router.get('/v1/updates', wrap(async (req, res) => {
  const q = parse(z.object({ limit: intParam(1, 100, 30), days: intParam(1, 30, 7), locality: id.optional() }), req.query, res);
  if (!q) return;
  res.json({ data: await latestUpdates({ limit: q.limit, days: q.days, localityId: q.locality ?? null }) });
}));

router.get('/v1/insights', wrap(async (req, res) => {
  const q = parse(z.object({ days: intParam(1, 90, 14) }), req.query, res);
  if (!q) return;
  res.json(await insights({ days: q.days }));
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
