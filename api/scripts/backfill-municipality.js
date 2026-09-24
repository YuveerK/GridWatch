// One-off: backfill InfraNode/Locality/Outage.municipalityId for rows that predate that column
// (ENGINE_AUDIT_2026-09-23.md finding 1). The municipality is derived from which account's posts
// taught the graph about each row, via EvidenceContribution/OutagePost -> SourcePost.sourceAccount
// -> SourceAccount.municipalityId. Only backfilled when the evidence is UNANIMOUS for one
// municipality; anything with no attributable evidence, or evidence split across more than one
// municipality, is left null and reported for manual follow-up (see CLAUDE.md "Fixing bad data").
// Safe to re-run: only rows still at municipalityId: null are considered each time.
//   node scripts/backfill-municipality.js            report only
//   node scripts/backfill-municipality.js --apply    write the unambiguous backfills
import { prisma } from '../src/db/prisma.js';

const apply = process.argv.includes('--apply');

const accounts = await prisma.sourceAccount.findMany({ select: { displayName: true, municipalityId: true } });
const municipalityByAccount = new Map(accounts.map((a) => [a.displayName, a.municipalityId]));
const posts = await prisma.sourcePost.findMany({ select: { id: true, sourceAccount: true } });
const municipalityByPost = new Map(posts.map((p) => [p.id, municipalityByAccount.get(p.sourceAccount) ?? null]));

/** municipalityId when every contributing post agrees, 'MIXED' when they disagree, null when there's no attributable evidence at all. */
function decide(postIds) {
  const municipalities = new Set(postIds.map((id) => municipalityByPost.get(id)).filter(Boolean));
  if (municipalities.size === 0) return null;
  if (municipalities.size > 1) return 'MIXED';
  return [...municipalities][0];
}

/** rows: [{ id, describe(), evidencePostIds(): Promise<string[]>, setMunicipality(id): Promise }] */
async function backfill(label, rows) {
  let done = 0;
  let noEvidence = 0;
  const mixed = [];
  // A row already scoped by LIVE traffic since this column existed (the app keeps running while this script does) can now
  // legitimately share (type, normalizedKey, municipalityId) with an old unscoped row this backfill wants to assign the same
  // way - that's not a backfill failure, it's the fix already working; it just means these two rows now need a real merge
  // (scripts/merge-nodes.js / merge-locality.js), not a blind municipalityId write.
  const collided = [];
  for (const row of rows) {
    const result = decide(await row.evidencePostIds());
    if (result === null) noEvidence++;
    else if (result === 'MIXED') mixed.push(row);
    else if (apply) {
      try {
        await row.setMunicipality(result);
        done++;
      } catch (err) {
        if (err.code === 'P2002') collided.push(row);
        else throw err;
      }
    } else {
      done++;
    }
  }
  console.log(`${label}: ${rows.length} unscoped, ${done} ${apply ? 'backfilled' : 'would backfill'}, ${noEvidence} with no attributable evidence (left null), ${mixed.length} mixed (left null, needs a person)${collided.length ? `, ${collided.length} collided with an already-scoped row (left null, needs a merge)` : ''}`);
  for (const row of mixed.slice(0, 20)) console.log(`  MIXED: ${row.describe()}`);
  if (mixed.length > 20) console.log(`  ... and ${mixed.length - 20} more`);
  for (const row of collided.slice(0, 20)) console.log(`  COLLIDED: ${row.describe()}`);
  if (collided.length > 20) console.log(`  ... and ${collided.length - 20} more`);
}

const nodes = await prisma.infraNode.findMany({ where: { municipalityId: null } });
await backfill('InfraNode', nodes.map((n) => ({
  describe: () => `${n.type} "${n.name}" (${n.id})`,
  evidencePostIds: async () => (await prisma.evidenceContribution.findMany({ where: { kind: 'NODE', refA: n.id }, select: { postId: true } })).map((e) => e.postId),
  setMunicipality: (municipalityId) => prisma.infraNode.update({ where: { id: n.id }, data: { municipalityId } }),
})));

const localities = await prisma.locality.findMany({ where: { municipalityId: null, regionId: null } });
await backfill('Learned Locality', localities.map((l) => ({
  describe: () => `"${l.canonicalName}" (${l.id})`,
  evidencePostIds: async () => (await prisma.evidenceContribution.findMany({ where: { kind: 'NODE_LOCALITY', refB: l.id }, select: { postId: true } })).map((e) => e.postId),
  setMunicipality: (municipalityId) => prisma.locality.update({ where: { id: l.id }, data: { municipalityId } }),
})));

const outages = await prisma.outage.findMany({ where: { municipalityId: null } });
await backfill('Outage', outages.map((o) => ({
  describe: () => `"${o.title}" [${o.status}] (${o.id})`,
  evidencePostIds: async () => (await prisma.outagePost.findMany({ where: { outageId: o.id }, select: { postId: true } })).map((e) => e.postId),
  setMunicipality: (municipalityId) => prisma.outage.update({ where: { id: o.id }, data: { municipalityId } }),
})));

if (!apply) console.log('\nReport only. Add --apply to write the unambiguous backfills.');
await prisma.$disconnect();
