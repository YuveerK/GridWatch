// Re-link specific posts after their reading changed (or to correct a link). Each post's old contribution is removed
// (timeline entries, decisions, graph evidence), the outages it touched are recomputed, and it is linked afresh.
//   node scripts/reprocess.js <postId> [<postId>...]              re-link from the stored readings (no AI)
//   node scripts/reprocess.js --reextract <postId> ...            also read the post again with the AI (paid)
// Oldest post first, so chronological linking is preserved.
import { prisma } from '../src/db/prisma.js';
import { reprocessPost } from '../src/modules/processing/processor.service.js';

const args = process.argv.slice(2);
const reextract = args.includes('--reextract');
const ids = args.filter((a) => !a.startsWith('--'));
if (!ids.length) {
  console.error('Give at least one post id.');
  process.exit(1);
}
const posts = await prisma.sourcePost.findMany({ where: { id: { in: ids } }, orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }], select: { id: true } });
for (const { id } of posts) console.log(await reprocessPost(id, { reextract }));
const missing = ids.filter((i) => !posts.some((p) => p.id === i));
if (missing.length) console.warn('Not found:', missing.join(', '));
await prisma.$disconnect();
