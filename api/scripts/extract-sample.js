import { prisma } from '../src/db/prisma.js';
import { extractPost } from '../src/modules/ai/extraction.service.js';

const n = Number(process.argv[2] ?? 8);
const posts = await prisma.sourcePost.findMany({
  where: { PostMedia: { some: {} } }, orderBy: { publishedAt: 'asc' }, skip: 20, take: n, select: { id: true, text: true, noteTweetText: true },
});
for (const p of posts) {
  const e = await extractPost(p.id, { force: true });
  console.log('\n===', (p.noteTweetText || p.text).slice(0, 110).replace(/\s+/g, ' '));
  console.log(e.status, e.relevance, `tokens ${e.inputTokens}/${e.outputTokens}`, e.error ?? '');
  console.log(JSON.stringify({ ...e.result, image_text: (e.result?.image_text ?? '').slice(0, 400) }, null, 1));
}
await prisma.$disconnect();
