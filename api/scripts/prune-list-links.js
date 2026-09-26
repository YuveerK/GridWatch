// Take back the asset -> suburb cross-links posts taught before localityTargets (infrastructure.service.js) was fixed: a
// reading listing several unrelated assets linked every suburb it named to every one of them (the Lenasia reservoir
// "supplied" Yeoville; Tshwane's PD line "supplied" the AE line's Elandsfontein). Every source is replayed through the
// fixed rule and exactly the records it would not have made are taken back: namesake links and real area lists stay, and
// so do the assets, the links between assets and official (SERVES) supply links. A link other posts also support just
// loses this post's count. Both services; --service=WATER|ELECTRICITY limits it to one.
//
//   node scripts/prune-list-links.js             preview
//   node scripts/prune-list-links.js --apply     remove, after saving a snapshot to data/backups/
//   node scripts/prune-list-links.js --restore <file>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { exclusive } from '../src/modules/coordination/lease.js';
import { removeContributions } from '../src/modules/infrastructure/infrastructure.service.js';
import { decodeEdgeEvidenceRef } from '../src/lib/evidence-edge.js';
import { localityTargets } from '../src/modules/infrastructure/infrastructure.service.js';
import { localityKey } from '../src/lib/normalize.js';

const backups = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');
const apply = process.argv.includes('--apply');
const only = (process.argv.find((a) => a.startsWith('--service=')) ?? '').split('=')[1] ?? null;
const restoreAt = process.argv.indexOf('--restore');

if (restoreAt > -1) {
  const { contributions, links } = JSON.parse(readFileSync(process.argv[restoreAt + 1], 'utf8'));
  const run = await exclusive(null, async () => {
    await prisma.evidenceContribution.createMany({ data: contributions.map((c) => ({ ...c, createdAt: new Date(c.createdAt) })), skipDuplicates: true });
    for (const l of links) {
      const data = { relationType: l.relationType, evidenceCount: l.evidenceCount, lastSeenAt: new Date(l.lastSeenAt) };
      await prisma.nodeLocality.upsert({ where: { nodeId_localityId: { nodeId: l.nodeId, localityId: l.localityId } }, create: { nodeId: l.nodeId, localityId: l.localityId, ...data }, update: data });
    }
  });
  console.log(run.acquired ? `Restored ${contributions.length} contribution(s) and ${links.length} link(s).` : 'Skipped: another worker holds the pipeline lease. Try again shortly.');
  await prisma.$disconnect();
  process.exit(run.acquired ? 0 : 1);
}

// Everything each source (post + fault) taught, from its own evidence records: the same facts learnFromExtraction saw.
const rows = (await prisma.$queryRaw`
  SELECT ec.*, sp."serviceType"::text AS "service" FROM "EvidenceContribution" ec JOIN "SourcePost" sp ON sp.id = ec."postId"
  WHERE ec.kind IN ('NODE', 'EDGE', 'NODE_LOCALITY')`).filter((r) => !only || r.service === only);
const bySource = new Map();
for (const r of rows) {
  const k = `${r.postId}|${r.faultIndex}`;
  bySource.set(k, [...(bySource.get(k) ?? []), r]);
}

const ids = (kind, pick) => [...new Set(rows.filter((r) => r.kind === kind).map(pick))];
const nodeById = new Map((await prisma.infraNode.findMany({ where: { id: { in: [...ids('NODE', (r) => r.refA), ...ids('NODE_LOCALITY', (r) => r.refA)] } }, select: { id: true, name: true } })).map((n) => [n.id, n]));
const placeName = new Map((await prisma.locality.findMany({ where: { id: { in: ids('NODE_LOCALITY', (r) => r.refB) } }, select: { id: true, canonicalName: true } })).map((l) => [l.id, l.canonicalName]));

/** The suburb words one source's reading used (the rule judges those, not the stored name: "Lawley" became "Lawley Ext 1 & 2"). */
async function readingNames(postId, faultIndex) {
  const [e] = await prisma.postExtraction.findMany({ where: { postId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 });
  const r = e?.result ?? {};
  const part = (r.faults?.length ?? 0) >= 2 ? r.faults[faultIndex] ?? {} : r;
  return (part.localities ?? []).map((l) => l.name).filter(Boolean);
}
/** The reading word a stored suburb came from: the same name, or the base it was resolved from ("Lawley" for "Lawley Ext 1 & 2"). */
const wordFor = (canonical, words) => words.find((w) => localityKey(w) === localityKey(canonical)) ?? words.find((w) => localityKey(canonical).startsWith(`${localityKey(w)} `)) ?? canonical;

// Replay each source's own facts through the fixed rule: roots = its assets minus those it gave a parent to; a link record is
// wrong when the rule would not have pointed that suburb at that asset.
const targets = [];
for (const [k, list] of bySource) {
  const links = list.filter((r) => r.kind === 'NODE_LOCALITY');
  if (!links.length) continue;
  const nodes = [...new Set(list.filter((r) => r.kind === 'NODE').map((r) => r.refA))].map((id) => nodeById.get(id)).filter(Boolean);
  const parentOf = new Map(list.filter((r) => r.kind === 'EDGE' && nodeById.has(r.refA)).map((r) => [decodeEdgeEvidenceRef(r.refB).childId, r.refA]));
  const roots = nodes.filter((n) => !parentOf.has(n.id)).length;
  if (roots <= 1) continue;
  const words = await readingNames(list[0].postId, list[0].faultIndex);
  const leaves = [...new Set(links.map((x) => x.refA))].map((id) => nodeById.get(id)).filter(Boolean);
  const wrong = links.filter((r) => {
    const word = wordFor(placeName.get(r.refB) ?? '', words);
    return !localityTargets({ rootCount: roots, nodes, leaves, parentOf }, word, words.length ? words : [word]).some((n) => n.id === r.refA);
  });
  if (wrong.length) targets.push({ key: k, postId: list[0].postId, faultIndex: list[0].faultIndex, service: list[0].service, roots, links: wrong });
}

const contributions = targets.flatMap((t) => t.links);
const pairs = [...new Set(contributions.map((c) => `${c.refA}|${c.refB}`))];
const current = await prisma.nodeLocality.findMany({ where: { OR: pairs.map((p) => ({ nodeId: p.split('|')[0], localityId: p.split('|')[1] })) }, include: { node: { select: { name: true } }, locality: { select: { canonicalName: true } } } });
const taken = new Map();
for (const c of contributions) taken.set(`${c.refA}|${c.refB}`, (taken.get(`${c.refA}|${c.refB}`) ?? 0) + 1);
const removed = current.filter((l) => l.relationType !== 'SERVES' && l.evidenceCount <= taken.get(`${l.nodeId}|${l.localityId}`));
const weakened = current.filter((l) => !removed.includes(l));

const posts = await prisma.sourcePost.findMany({ where: { id: { in: [...new Set(targets.map((t) => t.postId))] } }, select: { id: true, externalId: true, publishedAt: true } });
const perService = targets.reduce((m, t) => ((m[t.service] = (m[t.service] ?? 0) + 1), m), {});
console.log(`Readings that cross-linked a suburb to assets not named after it: ${targets.length} (from ${posts.length} posts) ${JSON.stringify(perService)}`);
console.log(`Wrong link records: ${contributions.length} on ${pairs.length} asset/suburb pair(s)`);
console.log(`  removed entirely (no other support): ${removed.length}`);
console.log(`  kept, one count lower (other posts or the official network also support it): ${weakened.length}`);
for (const l of removed.slice(0, 40)) console.log(`    - ${l.node.name}  x  ${l.locality.canonicalName}`);
if (removed.length > 40) console.log(`    ... and ${removed.length - 40} more`);

if (!apply) {
  console.log('\nPreview only. Run again with --apply to remove.');
  await prisma.$disconnect();
  process.exit(0);
}

mkdirSync(backups, { recursive: true });
const snapshot = path.join(backups, `list-links-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(snapshot, JSON.stringify({ at: new Date().toISOString(), contributions, links: current.map(({ node, locality, ...l }) => l) }, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
const run = await exclusive(null, async (ctx) => {
  for (const t of targets) {
    const wrong = new Set(t.links.map((r) => `${r.refA}|${r.refB}`));
    await removeContributions(t.postId, t.faultIndex, { ctx, kinds: ['NODE_LOCALITY'], match: (r) => wrong.has(`${r.refA}|${r.refB}`) });
  }
});
if (!run.acquired) {
  console.log('Skipped: another worker holds the pipeline lease. Nothing was changed. Try again shortly.');
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`\nRemoved. Snapshot: ${snapshot}`);
console.log(`Undo with: node scripts/prune-list-links.js --restore "${snapshot}"`);
await prisma.$disconnect();
