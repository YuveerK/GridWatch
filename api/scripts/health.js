import { prisma } from '../src/db/prisma.js';
import { formatHealth } from '../src/modules/processing/health.js';

const now = new Date();
const since = new Date(now.getTime() - 24 * 3_600_000);
const accounts = await prisma.sourceAccount.findMany({ orderBy: { displayName: 'asc' } });
const rows = [];
for (const a of accounts) {
  const [lastRun, lastPost, backlog, errors, reviews] = await Promise.all([
    prisma.ingestionRun.findFirst({ where: { sourceAccountId: a.id }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, checkpointAfter: true } }),
    prisma.sourcePost.findFirst({ where: { sourceAccount: a.displayName }, orderBy: { publishedAt: 'desc' }, select: { publishedAt: true, externalId: true } }),
    prisma.sourcePost.count({ where: { sourceAccount: a.displayName, processingStatus: 'UNPROCESSED' } }),
    prisma.sourcePost.count({ where: { sourceAccount: a.displayName, processingStatus: 'PROCESSING_ERROR' } }),
    prisma.reviewItem.count({ where: { status: 'OPEN', sampled: false, post: { sourceAccount: a.displayName } } }),
  ]);
  rows.push({
    displayName: a.displayName,
    serviceType: a.serviceType,
    active: a.active,
    lastPoll: lastRun?.startedAt?.toISOString() ?? null,
    lastNewPost: lastPost?.publishedAt?.toISOString() ?? null,
    latestExternalId: lastRun?.checkpointAfter || lastPost?.externalId || null,
    backlog,
    errors,
    openReviews: reviews,
  });
}
const [cycle, lease, unprocessed, stuck, posts, opened, updated, extractions] = await Promise.all([
  prisma.cycleQuality.findFirst({ where: { status: { not: 'RUNNING' } }, orderBy: { finishedAt: 'desc' }, select: { status: true } }),
  prisma.workLease.findUnique({ where: { name: 'pipeline' }, select: { expiresAt: true } }),
  prisma.sourcePost.count({ where: { processingStatus: 'UNPROCESSED' } }),
  prisma.sourcePost.count({ where: { processingStatus: 'PROCESSING', processingStartedAt: { lt: new Date(now.getTime() - 30 * 60_000) } } }),
  prisma.sourcePost.count({ where: { publishedAt: { gte: since } } }),
  prisma.outagePost.count({ where: { role: 'OPENED', postedAt: { gte: since } } }),
  prisma.outagePost.count({ where: { role: { not: 'OPENED' }, postedAt: { gte: since } } }),
  prisma.postExtraction.findMany({ where: { createdAt: { gte: since }, status: 'SUCCEEDED' }, select: { inputTokens: true, outputTokens: true, model: true } }),
]);
const text = formatHealth({
  accounts: rows,
  pipeline: { cycle: cycle?.status ?? null, leaseHeld: Boolean(lease && lease.expiresAt > now), unprocessed, stuck },
  activity: {
    posts,
    opened,
    updated,
    geminiCalls: extractions.length,
    inputTokens: extractions.reduce((n, e) => n + (e.inputTokens ?? 0), 0),
    outputTokens: extractions.reduce((n, e) => n + (e.outputTokens ?? 0), 0),
    model: extractions[0]?.model,
  },
});
console.log(text);
await prisma.$disconnect();
