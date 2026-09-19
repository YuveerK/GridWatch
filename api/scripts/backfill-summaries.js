// One-off: write a one-sentence summary for every outage update that lacks one. Spend-capped.
//   node scripts/backfill-summaries.js [--max=0.35]
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { generateJson } from '../src/modules/ai/gemini.client.js';

const MAX_USD = Number((process.argv.find((a) => a.startsWith('--max=')) ?? '--max=0.35').split('=')[1]);
const [inP, outP] = env.GEMINI_MODEL.includes('3.5-flash-lite') ? [0.3, 2.5] : [0.75, 3.75];
const clean = (t, n) => (t ?? '').replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

const SYSTEM = `You write one-sentence updates for residents from City Power outage posts.
Say what this update tells the resident: what is happening, the cause if stated, progress (percent restored, who is on site, tests, materials), what happens next, and any time estimate.
Rules: ONE sentence, max 25 words, plain English. Use ONLY facts in the input. No hashtags, phone numbers, thanks or apologies. Do not list more than 3 suburb names. If the input is a multi-fault graphic, describe ONLY the fault given.`;
const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

const all = await prisma.outagePost.findMany({
  orderBy: { postedAt: 'asc' },
  include: {
    outage: { select: { title: true } },
    post: { select: { id: true, text: true, noteTweetText: true, extractions: { where: { status: 'SUCCEEDED' }, take: 1, select: { result: true, imageText: true } } } },
  },
});
const have = new Set((await prisma.postSummary.findMany({ select: { postId: true, faultIndex: true } })).map((s) => `${s.postId}|${s.faultIndex}`));
const seen = new Set();
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '--limit=0').split('=')[1]);
let rows = all.filter((r) => {
  const key = `${r.postId}|${r.faultIndex}`;
  if (have.has(key) || seen.has(key)) return false;
  seen.add(key);
  return true;
});
if (LIMIT) rows = rows.slice(0, LIMIT);

console.log(`${rows.length} updates to summarise with ${env.GEMINI_MODEL}, spend cap $${MAX_USD}\n`);
let spent = 0;
let done = 0;
const queue = [...rows.entries()];

async function worker() {
  while (queue.length && spent < MAX_USD) {
    const [i, r] = queue.shift();
    const ex = r.post.extractions[0];
    const faultIndex = r.faultIndex;
    const fault = ex?.result?.faults?.length >= 2 || (ex?.result?.faults?.length === 1 && ex.result.relevance === 'SDC_SUMMARY') ? ex.result.faults[faultIndex] : null;
    const input = {
      outage: r.outage.title,
      update_type: r.role,
      post_text: clean(r.post.noteTweetText || r.post.text, 700),
      text_read_from_image: fault ? undefined : clean(ex?.imageText, 700),
      only_this_fault: fault ?? undefined,
    };
    try {
      const out = await generateJson({ systemInstruction: SYSTEM, parts: [{ text: JSON.stringify(input) }], jsonSchema: schema });
      spent += ((out.inputTokens ?? 0) * inP + (out.outputTokens ?? 0) * outP) / 1e6;
      const summary = JSON.parse(out.text).summary?.trim();
      if (summary) await prisma.postSummary.upsert({ where: { postId_faultIndex: { postId: r.postId, faultIndex } }, create: { postId: r.postId, faultIndex, summary, model: env.GEMINI_MODEL }, update: { summary, model: env.GEMINI_MODEL } });
      done++;
      if (done % 25 === 0 || done <= 3) console.log(`[${done}/${rows.length}] spent $${spent.toFixed(3)} | ${summary}`);
    } catch (err) {
      console.log(`  skip ${r.postId.slice(0, 8)}: ${err.message.slice(0, 80)}`);
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`\nDONE: ${done} summaries, spent $${spent.toFixed(3)}${spent >= MAX_USD ? ' (SPEND CAP REACHED)' : ''}, ${queue.length} left`);
await prisma.$disconnect();
