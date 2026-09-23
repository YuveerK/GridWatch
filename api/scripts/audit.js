// Data health audit: looks for contradictions between what an outage says and what its own posts say.
// Run: npm run audit      Exit code 1 if any check finds problems.
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { isStale } from '../src/modules/ai/extraction.service.js';
import { ingestionProblems, plannedOverdue, stuckProcessing } from '../src/modules/processing/quality.js';

const HOUR = 3_600_000;
const now = Date.now();
const short = (s) => (s ?? '').replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);

const outages = await prisma.outage.findMany({
  include: {
    localities: { include: { locality: { select: { canonicalName: true } } } },
    nodes: true,
    posts: { orderBy: { postedAt: 'asc' }, include: { post: { select: { externalId: true, text: true, noteTweetText: true, extractions: { where: { status: 'SUCCEEDED' }, take: 1, select: { result: true } } } } } },
  },
});

const checks = [];
const check = (name, why, hits, informational = false) => checks.push({ name, why, hits, informational });

const live = (o) => ['ACTIVE', 'PARTIALLY_RESTORED'].includes(o.status);

check(
  'Live but every suburb is restored',
  'status says outage, suburbs say power is back',
  outages.filter((o) => live(o) && o.localities.length > 0 && o.localities.every((l) => l.restored)),
);
check(
  'Restored but some suburb still unrestored',
  'status says fixed, a suburb was never restored',
  outages.filter((o) => o.status === 'RESTORED' && o.localities.some((l) => !l.restored)),
);
check(
  'Live but latest post says restored',
  'newest post is a restoration, outage still live',
  outages.filter((o) => {
    if (!live(o)) return false;
    const last = o.posts.at(-1)?.post.extractions[0]?.result;
    return last && last.status === 'RESTORED' && o.posts.at(-1).role === 'RESTORATION';
  }),
);
check(
  `Live with no update for ${env.OUTAGE_AUTOCLOSE_HOURS}h+ (sweep not run)`,
  'looks live but is stale',
  outages.filter((o) => live(o) && now - o.lastUpdateAt > env.OUTAGE_AUTOCLOSE_HOURS * HOUR),
);
check(
  'Restored/closed without a restoration time',
  'cannot show when it ended',
  outages.filter((o) => ['RESTORED', 'CLOSED'].includes(o.status) && !o.restoredAt && !o.posts.some((p) => p.role === 'RESTORATION') && o.kind === 'UNPLANNED' && o.status === 'RESTORED'),
);
check(
  'INFO: no suburb named by City Power (shown with likely areas from equipment)',
  'not an error: the suburb page lists these under "Possibly affected"',
  outages.filter((o) => o.localities.length === 0 && o.nodes.length > 0),
  true,
);
check(
  'No equipment and no suburbs',
  'nothing identifies it',
  outages.filter((o) => o.localities.length === 0 && o.nodes.length === 0),
);
check(
  'Planned outage past its window, still "Planned"',
  'the stored window ended over 6 hours ago (or, with no window, nothing for 10 days)',
  outages.filter((o) => plannedOverdue(o, now)),
);
check(
  'Very large outage (25+ suburbs)',
  'likely a merged umbrella of several faults',
  outages.filter((o) => o.localities.length >= 25),
);

const review = await prisma.sourcePost.count({ where: { processingStatus: { in: ['NEEDS_REVIEW', 'PROCESSING_ERROR'] } } });
const unprocessed = await prisma.sourcePost.count({ where: { processingStatus: 'UNPROCESSED' } });
const stuck = stuckProcessing(await prisma.sourcePost.findMany({ where: { processingStatus: 'PROCESSING' }, select: { processingStatus: true, processingStartedAt: true } }));
const ingest = ingestionProblems(await prisma.ingestionState.findUnique({ where: { accountId: env.X_SOURCE_ACCOUNT_ID } }));

let problems = 0;
console.log(`Audit of ${outages.length} outages\n`);
for (const c of checks) {
  const n = c.hits.length;
  if (!c.informational) problems += n;
  console.log(`${n === 0 ? 'OK  ' : c.informational ? 'INFO' : 'FAIL'}  ${c.name}: ${n}   (${c.why})`);
  for (const o of c.hits.slice(0, 4)) console.log(`        - ${o.title} [${o.status}] last update ${o.lastUpdateAt.toISOString().slice(0, 16)} | ${short(o.posts.at(-1)?.post.noteTweetText || o.posts.at(-1)?.post.text)}`);
}
const readings = await prisma.postExtraction.findMany({ where: { promptVersion: env.AI_PROMPT_VERSION }, select: { model: true, result: true, post: { select: { sourceAccount: true } } } });
const stale = readings.filter((r) => isStale(r, r.post.sourceAccount)).length;
console.log(`\n${stale === 0 ? 'OK  ' : 'WARN'}  Readings made with older instructions or another model: ${stale} of ${readings.length}${stale ? '   (run: npm run reread)' : ''}`);
console.log(`Posts needing review/errored: ${review}   Unprocessed posts: ${unprocessed}   Stuck in PROCESSING: ${stuck.length}`);
for (const p of ingest) console.log(`WARN  Ingestion: ${p}`);
// review, errored, unprocessed and stuck posts, and an unfinished or stale ingestion, are failures of the WORK, not just notes
const workProblems = review + unprocessed + stuck.length + ingest.length;
await prisma.$disconnect();
process.exit(problems || workProblems ? 1 : 0);
