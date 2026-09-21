// Undo a repair from its snapshot (every repair script saves one to data/backups/repair-*.json before it changes anything).
//   node scripts/restore-repair.js <file>            show what is in it and how the posts have changed since (changes nothing)
//   node scripts/restore-repair.js <file> --apply    put it all back, in one transaction, while holding the pipeline lease
import { prisma } from '../src/db/prisma.js';
import { PIPELINE, withLease } from '../src/modules/coordination/lease.js';
import { loadSnapshotFile } from '../src/modules/processing/repair-files.js';
import { describeChange, restoreSnapshot } from '../src/modules/processing/repair.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Give the snapshot file, for example: node scripts/restore-repair.js data/backups/repair-2026-09-22T00-00-00-000Z-reprocess.json');
  process.exit(1);
}
const snapshot = loadSnapshotFile(file);
console.log(`Snapshot taken ${snapshot.takenAt}: ${snapshot.postIds.length} post(s), ${snapshot.outages.length} outage(s), ${snapshot.outagePosts.length} entries.`);
for (const r of await describeChange(prisma, snapshot)) {
  console.log(`\n  ${r.externalId.slice(-10)}  ${r.changed ? 'CHANGED since the snapshot' : 'unchanged'}`);
  console.log(`      was: ${r.was.map((w) => w.label).join(' | ') || '(in no outage)'}`);
  console.log(`      now: ${r.is.map((w) => w.label).join(' | ') || '(in no outage)'}`);
}
if (!process.argv.includes('--apply')) {
  console.log('\nNothing changed. Add --apply to put the snapshot back.');
  await prisma.$disconnect();
  process.exit(0);
}
const held = await withLease(PIPELINE, async (ctx) => {
  const r = await restoreSnapshot({ prisma, snapshot, ctx });
  if (snapshot.extras?.removeAlias) {
    await prisma.nodeAlias.deleteMany({ where: snapshot.extras.removeAlias });
    console.log('Removed the alias the repair had added.');
  }
  return r;
});
if (!held.acquired) {
  console.error('Another worker holds the pipeline lease (a fetch is running). Nothing was changed; try again in a minute.');
  process.exit(1);
}
console.log(`\nRestored: ${held.value.posts} post(s), ${held.value.outages} outage(s) recomputed, ${held.value.entries} entries put back.`);
await prisma.$disconnect();
