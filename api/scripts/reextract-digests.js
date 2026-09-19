// Re-read digest-style graphics (several faults in one image) so `faults` is filled. Spend-guarded.
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { extractPost } from '../src/modules/ai/extraction.service.js';

const MAX_USD = Number((process.argv.find((a) => a.startsWith('--max=')) ?? '--max=0.6').split('=')[1]);
const [inP, outP] = env.GEMINI_MODEL.includes('3.5-flash-lite') ? [0.3, 2.5] : [0.75, 3.75];
const CREW_BUSY = /(as soon as they|as soon as the team|once (they|the team|operators) (are|is) (done|finished|complete)|are done at|after (they|the team) (finish|complete)|upon completion|afterwards|current task)/i;
const RE = /(open calls|sitting with \d+|\d+ (open )?calls|actively managing|see the attached|find the latest|latest update below|attached (are|information)|weekly maintenance)/i;

const rows = await prisma.postExtraction.findMany({
  where: { promptVersion: env.AI_PROMPT_VERSION, status: 'SUCCEEDED', relevance: { in: ['OUTAGE', 'UPDATE', 'SDC_SUMMARY', 'RESTORATION', 'PLANNED_OUTAGE'] } },
  include: { post: { select: { id: true, publishedAt: true, text: true, noteTweetText: true, PostMedia: { select: { id: true } } } } },
});
const todo = rows
  .filter((e) => {
    const r = e.result;
    const text = e.post.noteTweetText || e.post.text;
    // crew-busy phrasing: re-read even if already re-read once (prompt rule added later)
    if (r && CREW_BUSY.test(text) && !r.__crewRule) return true;
    if (!r || r.faults !== undefined || e.post.PostMedia.length === 0) return false;
    const eq = r.entities.filter((x) => x.type !== 'SDC').length;
    const cleaned = text.replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    const thinTwoRoots = cleaned.length < 90 && eq >= 2;
    return eq >= 4 || r.localities.length >= 6 || RE.test(text) || thinTwoRoots;
  })
  .sort((a, b) => a.post.publishedAt - b.post.publishedAt);

console.log(`model ${env.GEMINI_MODEL}: re-reading ${todo.length} digest-like posts, spend cap $${MAX_USD}\n`);
let spent = 0;
let multi = 0;
for (const [i, e] of todo.entries()) {
  const out = await extractPost(e.post.id, { force: true });
  spent += ((out.inputTokens ?? 0) * inP + (out.outputTokens ?? 0) * outP) / 1e6;
  const n = out.result?.faults?.length ?? 0;
  if (n >= 2) multi++;
  console.log(`[${i + 1}/${todo.length}] ${e.post.publishedAt.toISOString().slice(5, 16)} ${out.status} faults=${n} ${out.relevance ?? ''} | spent $${spent.toFixed(3)}`);
  if (spent > MAX_USD) {
    console.log('SPEND CAP REACHED, STOPPING');
    break;
  }
}
console.log(`\nDONE: ${multi} posts split into 2+ faults, spent $${spent.toFixed(3)}`);
await prisma.$disconnect();
