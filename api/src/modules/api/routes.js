import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { localityKey } from '../../lib/normalize.js';
import { ingestNewPosts } from '../ingestion/ingestion.service.js';
import { processPending, processPost } from '../processing/processor.service.js';

export const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const outageInclude = {
  localities: { include: { locality: { select: { id: true, canonicalName: true, Region: { select: { code: true, name: true } } } } } },
  nodes: { include: { node: { select: { id: true, type: true, name: true, lifecycle: true } } } },
};

/** Areas usually served by an outage's equipment, for outages whose posts named no suburb. Marked as inferred. */
async function withLikelyAreas(outages) {
  const bare = outages.filter((o) => o.localities.length === 0 && o.nodes.length > 0);
  if (!bare.length) return outages;
  const nodeIds = [...new Set(bare.flatMap((o) => o.nodes.map((n) => n.nodeId)))];
  const [learned, nodes] = await Promise.all([
    prisma.nodeLocality.findMany({ where: { nodeId: { in: nodeIds }, evidenceCount: { gte: 3 } }, include: { locality: { select: { id: true, canonicalName: true } } }, orderBy: { evidenceCount: 'desc' } }),
    prisma.infraNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, normalizedKey: true } }),
  ]);
  // a station named after a suburb ("Tshepisong Switching Station") is a decent hint for that suburb
  const sameName = await prisma.locality.findMany({ where: { normalizedName: { in: nodes.map((n) => n.normalizedKey) } }, select: { id: true, canonicalName: true, normalizedName: true } });
  const keyById = new Map(nodes.map((n) => [n.id, n.normalizedKey]));
  for (const o of bare) {
    const seen = new Map();
    for (const n of o.nodes) {
      for (const l of learned.filter((x) => x.nodeId === n.nodeId)) seen.set(l.locality.id, l.locality.canonicalName);
      for (const l of sameName.filter((x) => x.normalizedName === keyById.get(n.nodeId))) seen.set(l.id, l.canonicalName);
    }
    o.likelyAreas = [...seen].slice(0, 8).map(([id, canonicalName]) => ({ id, canonicalName }));
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
  infrastructure: o.nodes?.map((n) => n.node),
  localities: o.localities?.map((l) => ({ ...l.locality, restored: l.restored })),
  likelyAreas: o.likelyAreas ?? [],
});

router.get('/health', wrap(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true });
}));

router.get('/v1/outages', wrap(async (req, res) => {
  const { status, sdc, suburb, region, limit = '50' } = req.query;
  const where = {};
  if (status) where.status = { in: String(status).split(',') };
  else where.status = { in: ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED'] };
  if (sdc) where.sdcName = { equals: String(sdc), mode: 'insensitive' };
  const locality = {};
  if (suburb) locality.normalizedName = { contains: localityKey(suburb) };
  if (region) locality.Region = { code: String(region).toUpperCase() };
  if (Object.keys(locality).length) where.localities = { some: { locality } };
  const outages = await withLikelyAreas(await prisma.outage.findMany({ where, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: Math.min(Number(limit) || 50, 200) }));
  res.json({ data: outages.map(shapeOutage) });
}));

router.get('/v1/outages/:id', wrap(async (req, res) => {
  const outage = await prisma.outage.findUnique({
    where: { id: req.params.id },
    include: { ...outageInclude, posts: { orderBy: { postedAt: 'asc' }, include: { post: { select: { externalId: true, text: true, noteTweetText: true, publishedAt: true, PostMedia: { select: { url: true } }, extractions: { select: { imageText: true } } } } } } },
  });
  if (!outage) return res.status(404).json({ error: 'not_found' });
  await withLikelyAreas([outage]);
  res.json({
    ...shapeOutage(outage),
    timeline: outage.posts.map((p) => ({
      role: p.role,
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
      nodes: { some: { node: { OR: [{ localities: { some: { localityId: req.params.id, evidenceCount: { gte: 3 } } } }, { normalizedKey: loc?.normalizedName ?? '\u0000' }] } } },
    },
    include: outageInclude,
    orderBy: { lastUpdateAt: 'desc' },
    take: 20,
  });
  res.json({ data: outages.map(shapeOutage), possible: (await withLikelyAreas(possible)).map(shapeOutage) });
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
  res.json(node);
}));

router.get('/v1/infrastructure', wrap(async (req, res) => {
  const { type, q } = req.query;
  const nodes = await prisma.infraNode.findMany({
    where: { ...(type ? { type: String(type).toUpperCase() } : {}), ...(q ? { normalizedKey: { contains: localityKey(q) } } : {}) },
    orderBy: { evidenceCount: 'desc' },
    take: 100,
  });
  res.json({ data: nodes });
}));

// ── admin ──
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
