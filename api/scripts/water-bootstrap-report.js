// Report on stored Johannesburg Water posts and the incidents built from them.
//   node scripts/water-bootstrap-report.js --handle JHBWater --from 2026-09-01
import { prisma } from '../src/db/prisma.js';
import { WATER_PROMPT_VERSION } from '../src/modules/ai/prompts/water.prompt.js';
import { crossServiceLinks, giantWaterIncidents, recoveringMarkedRestored, waterNodesWithElectricityTypes } from '../src/modules/processing/quality.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const handle = flag('handle') ?? 'JHBWater';
const from = new Date(flag('from') ?? '2026-09-01T00:00:00+02:00');

const posts = await prisma.sourcePost.findMany({
  where: { sourceAccount: handle, publishedAt: { gte: from } },
  select: { id: true, serviceType: true, publishedAt: true, processingStatus: true, PostMedia: { select: { id: true } }, extractions: { select: { status: true, relevance: true, promptVersion: true } } },
});
const outages = await prisma.outage.findMany({
  where: { serviceType: 'WATER' },
  select: { id: true, status: true, serviceType: true, _count: { select: { localities: true, nodes: true, posts: true } } },
});
const decisions = await prisma.linkDecision.findMany({
  where: { post: { sourceAccount: handle, publishedAt: { gte: from } } },
  select: { outcome: true, postId: true, post: { select: { serviceType: true } }, outage: { select: { serviceType: true } } },
});
const currentLinks = await prisma.outagePost.findMany({
  where: { post: { sourceAccount: handle, serviceType: 'WATER', publishedAt: { gte: from } } },
  select: { postId: true, role: true, outageId: true },
});
const nodes = await prisma.infraNode.findMany({ where: { serviceType: 'WATER' }, select: { type: true, serviceType: true, lifecycle: true, evidenceCount: true } });
const learnedEdges = await prisma.evidenceContribution.count({ where: { kind: 'EDGE', post: { sourceAccount: handle, serviceType: 'WATER' } } });
const learnedLocalities = await prisma.evidenceContribution.count({ where: { kind: 'NODE_LOCALITY', post: { sourceAccount: handle, serviceType: 'WATER' } } });
const reviews = await prisma.reviewItem.count({ where: { status: 'OPEN', post: { sourceAccount: handle } } });
const errors = posts.filter((p) => p.processingStatus === 'PROCESSING_ERROR').length;
const reads = posts.flatMap((p) => p.extractions);
let currentOk = 0;
let currentFail = 0;
let noCurrent = 0;
let oldOk = 0;
let oldFail = 0;
for (const p of posts) {
  const cur = p.extractions.find((e) => e.promptVersion === WATER_PROMPT_VERSION);
  if (!cur) noCurrent += 1;
  else if (cur.status === 'SUCCEEDED') currentOk += 1;
  else if (cur.status === 'FAILED') currentFail += 1;
  for (const e of p.extractions) {
    if (e.promptVersion === WATER_PROMPT_VERSION) continue;
    if (e.status === 'SUCCEEDED') oldOk += 1;
    if (e.status === 'FAILED') oldFail += 1;
  }
}
const byRole = {};
for (const link of currentLinks) byRole[link.role] = (byRole[link.role] ?? 0) + 1;
const postsByOutage = new Map();
for (const link of currentLinks) {
  if (!postsByOutage.has(link.postId)) postsByOutage.set(link.postId, new Set());
  postsByOutage.get(link.postId).add(link.role);
}
let opened = 0;
let onlyUpdated = 0;
for (const roles of postsByOutage.values()) {
  if (roles.has('OPENED')) opened += 1;
  else onlyUpdated += 1;
}
const byStatus = {};
for (const o of outages) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
const byType = {};
for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
const byOutcome = {};
for (const d of decisions) byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
const crossed = crossServiceLinks(decisions.map((d) => ({ postService: d.post.serviceType, outageService: d.outage?.serviceType })));
const badTypes = waterNodesWithElectricityTypes(nodes);
const giants = giantWaterIncidents(outages.map((o) => ({ serviceType: o.serviceType, localities: o._count.localities, nodes: o._count.nodes })));
const restored = await prisma.outagePost.findMany({
  where: { outage: { serviceType: 'WATER', status: 'RESTORED' }, post: { sourceAccount: handle } },
  select: { effect: true, post: { select: { text: true, noteTweetText: true } }, outage: { select: { status: true } } },
});
const falseRestores = recoveringMarkedRestored(restored.map((p) => ({ status: p.outage.status, text: p.post.noteTweetText || p.post.text, cause: p.effect?.cause })));

const line = (k, v) => console.log(`${String(k).padEnd(28)} ${v}`);
console.log(`\nJohannesburg Water bootstrap report  (${handle} from ${from.toISOString()})\n`);
line('total posts', posts.length);
line('service WATER', posts.filter((p) => p.serviceType === 'WATER').length);
line('earliest', posts.length ? posts.reduce((a, p) => (p.publishedAt < a.publishedAt ? p : a)).publishedAt.toISOString() : '-');
line('latest', posts.length ? posts.reduce((a, p) => (p.publishedAt > a.publishedAt ? p : a)).publishedAt.toISOString() : '-');
line('posts with images', posts.filter((p) => p.PostMedia.length).length);
line('unique posts', posts.length);
line(`current ${WATER_PROMPT_VERSION} succeeded`, currentOk);
line(`current ${WATER_PROMPT_VERSION} failed`, currentFail);
line(`no current ${WATER_PROMPT_VERSION} reading`, noCurrent);
line('historical older-version succeeded', oldOk);
line('historical older-version failed', oldFail);
line('extraction rows succeeded', reads.filter((r) => r.status === 'SUCCEEDED').length);
line('extraction rows failed', reads.filter((r) => r.status === 'FAILED').length);
console.log('\nIncidents');
line('total water incidents', outages.length);
for (const status of ['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'STALE', 'PLANNED', 'CANCELLED', 'CLOSED']) line(status.toLowerCase(), byStatus[status] ?? 0);
console.log('\nCurrent fault decisions');
line('current final decisions', decisions.length);
for (const outcome of ['NEW', 'LINKED', 'NEEDS_REVIEW']) line(`current ${outcome} faults`, byOutcome[outcome] ?? 0);
console.log('\nCurrent links');
line('current outage-post rows', currentLinks.length);
for (const role of ['OPENED', 'UPDATE', 'RESTORATION']) line(`current ${role} faults`, byRole[role] ?? 0);
line('posts that opened an incident', opened);
line('posts that only updated incidents', onlyUpdated);
console.log('\nInfrastructure');
for (const [type, n] of Object.entries(byType).sort()) line(type, n);
line('relationships from posts', learnedEdges);
line('locality links from posts', learnedLocalities);
console.log('\nQuality');
line('review items', reviews);
line('processing errors', errors);
line('cross-service errors', crossed.length);
line('false restorations', falseRestores.length);
line('suspicious giant incidents', giants.length);
line('electricity-typed water nodes', badTypes.length);
await prisma.$disconnect();
process.exit(crossed.length || badTypes.length || falseRestores.length ? 1 : 0);
