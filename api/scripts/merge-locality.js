// Merge a duplicate suburb (usually a City Power typo that became its own suburb) into the real one.
//   node scripts/merge-locality.js --from=<id> --into=<id>            report only
//   node scripts/merge-locality.js --from=<id> --into=<id> --apply    do it, in one transaction
// Everything that pointed at the duplicate (outages, equipment links, evidence records) points at the real suburb afterwards,
// the duplicate's name is kept as an alias so the typo resolves correctly next time, and the duplicate is removed.
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma.js';
import { localityKey } from '../src/lib/normalize.js';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const from = arg('from');
const into = arg('into');
const apply = process.argv.includes('--apply');
if (!from || !into || from === into) {
  console.error('Give --from=<duplicate id> and --into=<real id>.');
  process.exit(1);
}
const [dup, real] = await Promise.all([prisma.locality.findUnique({ where: { id: from } }), prisma.locality.findUnique({ where: { id: into } })]);
if (!dup || !real) {
  console.error('One of those suburbs does not exist.');
  process.exit(1);
}
const counts = {
  outages: await prisma.outageLocality.count({ where: { localityId: from } }),
  equipmentLinks: await prisma.nodeLocality.count({ where: { localityId: from } }),
  evidence: await prisma.evidenceContribution.count({ where: { kind: 'NODE_LOCALITY', refB: from } }),
};
console.log(`Merge "${dup.canonicalName}" (${from}) into "${real.canonicalName}" (${into})`, counts);
if (!apply) {
  console.log('Nothing changed. Re-run with --apply.');
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.$transaction(async (tx) => {
  for (const ol of await tx.outageLocality.findMany({ where: { localityId: from } })) {
    const existing = await tx.outageLocality.findUnique({ where: { outageId_localityId: { outageId: ol.outageId, localityId: into } } });
    if (existing) await tx.outageLocality.update({ where: { outageId_localityId: { outageId: ol.outageId, localityId: into } }, data: { restored: existing.restored || ol.restored } });
    else await tx.outageLocality.create({ data: { outageId: ol.outageId, localityId: into, restored: ol.restored } });
    await tx.outageLocality.delete({ where: { outageId_localityId: { outageId: ol.outageId, localityId: from } } });
  }
  for (const nl of await tx.nodeLocality.findMany({ where: { localityId: from } })) {
    const existing = await tx.nodeLocality.findUnique({ where: { nodeId_localityId: { nodeId: nl.nodeId, localityId: into } } });
    if (existing) await tx.nodeLocality.update({ where: { nodeId_localityId: { nodeId: nl.nodeId, localityId: into } }, data: { evidenceCount: existing.evidenceCount + nl.evidenceCount, lastSeenAt: existing.lastSeenAt > nl.lastSeenAt ? existing.lastSeenAt : nl.lastSeenAt } });
    else await tx.nodeLocality.create({ data: { nodeId: nl.nodeId, localityId: into, evidenceCount: nl.evidenceCount, lastSeenAt: nl.lastSeenAt } });
    await tx.nodeLocality.delete({ where: { nodeId_localityId: { nodeId: nl.nodeId, localityId: from } } });
  }
  for (const ev of await tx.evidenceContribution.findMany({ where: { kind: 'NODE_LOCALITY', refB: from } })) {
    const clash = await tx.evidenceContribution.findFirst({ where: { postId: ev.postId, faultIndex: ev.faultIndex, kind: ev.kind, refA: ev.refA, refB: into } });
    if (clash) await tx.evidenceContribution.deleteMany({ where: { postId: ev.postId, faultIndex: ev.faultIndex, kind: ev.kind, refA: ev.refA, refB: from } });
    else await tx.evidenceContribution.updateMany({ where: { postId: ev.postId, faultIndex: ev.faultIndex, kind: ev.kind, refA: ev.refA, refB: from }, data: { refB: into } });
  }
  const alias = localityKey(dup.canonicalName);
  if (!(await tx.localityAlias.findUnique({ where: { localityId_normalizedAlias: { localityId: into, normalizedAlias: alias } } }))) {
    await tx.localityAlias.create({ data: { id: randomUUID(), localityId: into, alias: dup.canonicalName, normalizedAlias: alias, source: 'merged-typo', status: 'CONFIRMED' } });
  }
  await tx.locality.delete({ where: { id: from } });
});
console.log('Merged.');
await prisma.$disconnect();
