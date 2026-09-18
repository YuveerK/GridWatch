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
  const outages = await prisma.outage.findMany({ where, include: outageInclude, orderBy: { lastUpdateAt: 'desc' }, take: Math.min(Number(limit) || 50, 200) });
  res.json({ data: outages.map(shapeOutage) });
}));

router.get('/v1/outages/:id', wrap(async (req, res) => {
  const outage = await prisma.outage.findUnique({
    where: { id: req.params.id },
    include: { ...outageInclude, posts: { orderBy: { postedAt: 'asc' }, include: { post: { select: { externalId: true, text: true, noteTweetText: true, publishedAt: true, PostMedia: { select: { url: true } }, extractions: { select: { imageText: true } } } } } } },
  });
  if (!outage) return res.status(404).json({ error: 'not_found' });
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

router.get('/v1/localities/:id/outages', wrap(async (req, res) => {
  const outages = await prisma.outage.findMany({
    where: { localities: { some: { localityId: req.params.id } } },
    include: outageInclude,
    orderBy: { lastUpdateAt: 'desc' },
    take: 50,
  });
  res.json({ data: outages.map(shapeOutage) });
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
    select: { id: true, externalId: true, text: true, publishedAt: true, processingStatus: true, linkDecision: true, extractions: { select: { status: true, error: true } } },
  });
  res.json({ data: posts });
}));
