// Re-link specific posts after their reading changed (or to correct a link). Each post's old contribution is removed
// (timeline entries, decisions, graph evidence), the outages it touched are recomputed, and it is linked afresh.
//   node scripts/reprocess.js <postId> [<postId>...]              re-link from the stored readings (no AI)
//   node scripts/reprocess.js --reextract <postId> ...            also read the post again with the AI (paid)
//   node scripts/reprocess.js --preview <postId> ...              show where each post is now and what would be saved; change nothing
// Before anything changes a snapshot is saved to data/backups/repair-*.json (skip with --no-snapshot); afterwards the change is shown and the
// undo command printed:  node scripts/restore-repair.js <that file> --apply
// Oldest post first, so chronological linking is preserved.
import { prisma } from '../src/db/prisma.js';
import { reprocessPost } from '../src/modules/processing/processor.service.js';
import { saveSnapshotFile } from '../src/modules/processing/repair-files.js';
import { describeChange, snapshotForPosts } from '../src/modules/processing/repair.js';

const args = process.argv.slice(2);
const reextract = args.includes('--reextract');
const ids = args.filter((a) => !a.startsWith('--'));
if (!ids.length) {
  console.error('Give at least one post id.');
  process.exit(1);
}
const posts = await prisma.sourcePost.findMany({ where: { id: { in: ids } }, orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }], select: { id: true } });
const snapshot = await snapshotForPosts(prisma, posts.map((p) => p.id));
const show = async () => {
  for (const r of await describeChange(prisma, snapshot)) {
    console.log(`  ${r.externalId.slice(-10)}  ${r.changed ? 'CHANGED' : 'unchanged'}`);
    console.log(`      was: ${r.was.map((w) => w.label).join(' | ') || '(in no outage)'}`);
    console.log(`      now: ${r.is.map((w) => w.label).join(' | ') || '(in no outage)'}`);
  }
};
if (args.includes('--preview')) {
  console.log(`Would re-link ${posts.length} post(s), oldest first${reextract ? ', re-reading each with the AI (paid)' : ' from their stored readings (no AI)'}. Where they are now:`);
  await show();
  console.log(`\nA snapshot of ${snapshot.outages.length} outage(s), ${snapshot.outagePosts.length} entries and ${snapshot.evidence.length} pieces of graph evidence would be saved first. Nothing changed.`);
  await prisma.$disconnect();
  process.exit(0);
}
const snapshotFile = args.includes('--no-snapshot') ? null : saveSnapshotFile(snapshot, 'reprocess');
if (snapshotFile) console.log(`Snapshot saved: ${snapshotFile}`);
for (const { id } of posts) console.log(await reprocessPost(id, { reextract }));
console.log('\nWhat changed:');
await show();
if (snapshotFile) console.log(`\nTo undo:  node scripts/restore-repair.js ${snapshotFile} --apply`);
const missing = ids.filter((i) => !posts.some((p) => p.id === i));
if (missing.length) console.warn('Not found:', missing.join(', '));
await prisma.$disconnect();
