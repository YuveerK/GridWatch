// Data health audit: looks for contradictions between what an outage says and what its own posts say.
// Run: npm run audit      Exit code 1 if any check finds problems.
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { isStale } from '../src/modules/ai/extraction.service.js';
import { readerFor } from '../src/modules/ai/reader-registry.js';
import { auditSummary, crossServiceLinks, giantWaterIncidents, ingestionProblems, largeUnplannedOutages, legitimateLargeWaterIncidents, plannedOverdue, recoveringMarkedRestored, stuckProcessing, waterNodesWithElectricityTypes } from '../src/modules/processing/quality.js';

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
const check = (name, why, hits, informational = false, scope = 'ELECTRICITY') => checks.push({ name, why, hits, informational, scope });

const live = (o) => ['ACTIVE', 'PARTIALLY_RESTORED'].includes(o.status);

check(
  'Live but every suburb is restored',
  'status says outage, suburbs say power is back',
  outages.filter((o) => live(o) && !(o.serviceType === 'WATER' && o.waterState && o.waterState !== 'NORMAL') && o.localities.length > 0 && o.localities.every((l) => l.restored)),
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
    if (o.serviceType === 'WATER' && o.waterState && o.waterState !== 'NORMAL') return false;
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
  'Very large unplanned outage (25+ suburbs)',
  'likely a merged umbrella of several faults',
  largeUnplannedOutages(outages),
);
check(
  'Large planned outage (25+ suburbs)',
  'one announced isolation with a wide footprint; not treated as a failed merge',
  outages.filter((o) => o.kind === 'PLANNED' && o.localities.length >= 25),
  true,
);

const links = await prisma.outagePost.findMany({ select: { post: { select: { serviceType: true, externalId: true } }, outage: { select: { serviceType: true, title: true, status: true, lastUpdateAt: true } } } });
const crossed = crossServiceLinks(links.map((r) => ({ postService: r.post.serviceType, outageService: r.outage.serviceType, title: r.outage.title, status: r.outage.status, lastUpdateAt: r.outage.lastUpdateAt, posts: [{ post: { text: r.post.externalId } }] })));
check('Water post joined to an electricity outage, or the reverse', 'services must stay isolated', crossed, false, 'CROSS');

const waterNodes = await prisma.infraNode.findMany({ where: { serviceType: 'WATER' }, select: { serviceType: true, type: true, name: true } });
const badTypes = waterNodesWithElectricityTypes(waterNodes);
check('Water equipment stored as an electricity type', 'reservoirs and towers must not use electricity types', badTypes.map((n) => ({ title: `${n.type} ${n.name}`, status: 'WATER', lastUpdateAt: new Date(), posts: [] })), false, 'WATER');

const waterPosts = await prisma.outagePost.findMany({
  where: { outage: { serviceType: 'WATER', status: 'RESTORED' } },
  select: { outage: { select: { title: true, status: true, lastUpdateAt: true, waterState: true } }, post: { select: { text: true, noteTweetText: true } }, effect: true },
});
const falseRestores = recoveringMarkedRestored(waterPosts.map((p) => ({ text: p.post.noteTweetText || p.post.text, cause: p.effect?.cause, status: p.outage.status, title: p.outage.title, lastUpdateAt: p.outage.lastUpdateAt })));
check('Pumping or levels recovering marked the incident restored', 'customer supply was not confirmed', falseRestores.map((p) => ({ title: p.title, status: p.status, lastUpdateAt: p.lastUpdateAt, posts: [{ post: { text: p.text } }] })), false, 'WATER');

const waterOutages = await prisma.outage.findMany({
  where: { serviceType: 'WATER' },
  select: {
    serviceType: true, title: true, status: true, waterState: true, lastUpdateAt: true,
    nodes: { select: { node: { select: { type: true, name: true } } } },
    localities: { select: { impactBasis: true } },
    posts: { select: { effect: true } },
  },
});
const waterShaped = waterOutages.map((o) => ({
  ...o,
  nodes: o.nodes.map((n) => ({ type: n.node.type, name: n.node.name })),
  effectStates: [...new Set(o.posts.map((p) => p.effect?.waterState).filter(Boolean))],
}));
const giants = giantWaterIncidents(waterShaped);
const wideZones = legitimateLargeWaterIncidents(waterShaped);
const showWater = (o) => ({ title: o.title, status: o.status, lastUpdateAt: o.lastUpdateAt, posts: [] });
check('Very large water incident', 'several assets or operating conditions were kept as one incident', giants.map(showWater), false, 'WATER');
check('Large explicit water supply zone', 'one asset, one condition, suburbs named by the source', wideZones.map(showWater), true, 'WATER');

const waterReviews = await prisma.reviewItem.findMany({ where: { status: 'OPEN', post: { serviceType: 'WATER' } }, select: { reasons: true, post: { select: { externalId: true, text: true } } }, take: 50 });
if (waterReviews.length) {
  console.log(`\nOpen Johannesburg Water review items: ${waterReviews.length}`);
  for (const item of waterReviews) console.log(`        - ${item.post.externalId} ${JSON.stringify(item.reasons)} ${short(item.post.text)}`);
}

const review = await prisma.sourcePost.count({ where: { processingStatus: { in: ['NEEDS_REVIEW', 'PROCESSING_ERROR'] } } });
const unprocessed = await prisma.sourcePost.count({ where: { processingStatus: 'UNPROCESSED' } });
const stuck = stuckProcessing(await prisma.sourcePost.findMany({ where: { processingStatus: 'PROCESSING' }, select: { processingStatus: true, processingStartedAt: true } }));
// every active account, not just the env-configured default: a stale/missing checkpoint on a secondary account (e.g. Tshwane) is
// otherwise invisible here while the default account looks healthy.
const accounts = await prisma.sourceAccount.findMany({ where: { active: true } });
const ingest = accounts.length
  ? (await Promise.all(accounts.map(async (a) => ingestionProblems(await prisma.ingestionState.findUnique({ where: { accountId: a.externalId } })).map((p) => `${a.displayName}: ${p}`)))).flat()
  : ingestionProblems(await prisma.ingestionState.findUnique({ where: { accountId: env.X_SOURCE_ACCOUNT_ID } }));

let problems = 0;
console.log(`Audit of ${outages.length} outages\n`);
for (const c of checks) {
  const n = c.hits.length;
  if (!c.informational) problems += n;
  console.log(`${n === 0 ? 'OK  ' : c.informational ? 'INFO' : 'FAIL'}  ${c.name}: ${n}   (${c.why})`);
  for (const o of c.hits.slice(0, 4)) console.log(`        - ${o.title} [${o.status}] last update ${o.lastUpdateAt.toISOString().slice(0, 16)} | ${short(o.posts.at(-1)?.post.noteTweetText || o.posts.at(-1)?.post.text)}`);
}
const split = [];
for (const c of checks) {
  if (c.scope !== 'ELECTRICITY') { split.push(c); continue; }
  const water = c.hits.filter((o) => o.serviceType === 'WATER');
  const elec = c.hits.filter((o) => o.serviceType !== 'WATER');
  if (water.length) split.push({ ...c, scope: 'WATER', hits: water });
  split.push({ ...c, hits: elec });
}
const allReadings = await prisma.postExtraction.findMany({ select: { promptVersion: true, model: true, result: true, post: { select: { sourceAccount: true, serviceType: true } } } });
const readings = allReadings.filter((r) => r.promptVersion === (readerFor(r.post.serviceType).promptVersion ?? env.AI_PROMPT_VERSION));
const staleRows = readings.filter((r) => isStale(r, r.post.sourceAccount, r.post.serviceType));
const staleBy = { ELECTRICITY: 0, WATER: 0 };
for (const r of staleRows) {
  const svc = r.post.serviceType === 'WATER' ? 'WATER' : 'ELECTRICITY';
  staleBy[svc] += 1;
}
console.log(`\n${staleRows.length === 0 ? 'OK  ' : 'WARN'}  Readings made with older instructions or another model: ${staleRows.length} of ${readings.length}${staleRows.length ? '   (run: npm run reread)' : ''}`);
console.log(`Posts needing review/errored: ${review}   Unprocessed posts: ${unprocessed}   Stuck in PROCESSING: ${stuck.length}`);
for (const p of ingest) console.log(`WARN  Ingestion: ${p}`);
const errored = await prisma.sourcePost.count({ where: { processingStatus: 'PROCESSING_ERROR' } });
split.push({ scope: 'ELECTRICITY', kind: 'warn', hits: Array.from({ length: staleBy.ELECTRICITY }) });
split.push({ scope: 'WATER', kind: 'warn', hits: Array.from({ length: staleBy.WATER }) });
split.push({ scope: 'PIPELINE', hits: Array.from({ length: unprocessed + stuck.length + errored + (review - errored) + ingest.length }) });
const summary = auditSummary(split);
const workProblems = review + unprocessed + stuck.length + ingest.length;
const failed = problems || workProblems;
console.log('\nAUDIT SUMMARY\n');
for (const [name, label] of [['ELECTRICITY', 'ELECTRICITY'], ['WATER', 'WATER'], ['CROSS', 'CROSS-SERVICE']]) {
  const b = summary.buckets[name];
  console.log(label);
  console.log(`  hard failures:   ${b.hard}`);
  console.log(`  warnings:        ${b.warn}`);
  console.log(`  informational:   ${b.info}\n`);
}
console.log('PIPELINE');
console.log(`  unprocessed:        ${unprocessed}`);
console.log(`  stuck:              ${stuck.length}`);
console.log(`  processing errors:  ${errored}`);
console.log(`  needs review:       ${review - errored}`);
console.log(`\nRESULT\n  ${failed ? 'FAIL' : 'PASS'}`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
