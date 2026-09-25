import { prisma } from '../src/db/prisma.js';
import { processPending, resetLearnedState } from '../src/modules/processing/processor.service.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const limit = flag('limit') != null ? Number(flag('limit')) : undefined;
const verbose = args.includes('--verbose');
const sourceAccount = flag('source-account') ?? flag('handle');
const serviceType = flag('service') ? flag('service').toUpperCase() : null;
const from = flag('from') ? new Date(flag('from')) : null;

if (args.includes('--reset')) {
  // wipes every outage and everything learned about the network, then replays from the stored readings
  if (!args.includes('--confirm')) {
    console.error('--reset deletes all outages, links and learned equipment. Re-run with --reset --confirm if that is what you want.');
    process.exit(1);
  }
  await resetLearnedState();
  console.log('learned state reset (extractions kept)\n');
}

const posts = new Map((await prisma.sourcePost.findMany({ select: { id: true, publishedAt: true, text: true, noteTweetText: true } })).map((p) => [p.id, p]));
const started = Date.now();
let freshCalls = 0;

const onPost = (res, n, total) => {
  const post = posts.get(res.postId);
  const when = post.publishedAt.toISOString().slice(5, 16).replace('T', ' ');
  const text = (post.noteTweetText || post.text).replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const head = `[${String(n).padStart(4)}/${total}] ${when} "${text}"`;
  const d = res.detail;
  if (d?.fresh) freshCalls++;
  if (!verbose) return;
  if (res.outcome === 'SKIPPED_REPLY') return console.log(`${head}\n         -> skipped (customer reply)`);
  if (!d) return console.log(`${head}\n         -> ${res.outcome}${res.error ? ` ${res.error}` : ''}`);
  const read = `${d.fresh ? `GEMINI ${d.tokens} tok` : 'cached'} | ${d.relevance}/${d.status} | ${d.sdc ?? 'no SDC'} | equipment: ${d.nodes.join(', ') || '-'} | suburbs ${d.matchedLocalities}/${d.localities} matched`;
  console.log(`${head}\n         read: ${read}`);
  if (d.outageTitle) {
    const verb = res.outcome === 'LINKED' ? `LINKED to` : 'NEW outage';
    console.log(`         -> ${verb} "${d.outageTitle}" [${d.outageStatus}, ${d.outagePosts} post${d.outagePosts === 1 ? '' : 's'}]${d.usedLlm ? ' (Gemini tie-break)' : ''}${res.outcome === 'LINKED' ? ` score ${d.topScore}: ${d.reason?.slice(0, 80)}` : ''}`);
  } else {
    console.log(`         -> ${res.outcome}${d.reason ? `: ${d.reason}` : ''}`);
  }
  if (n % 25 === 0) console.log(`\n=== ${n}/${total} done, ${freshCalls} fresh Gemini reads, ${((Date.now() - started) / 60000).toFixed(1)} min elapsed ===\n`);
};

// --sweep-as-of: replay history as if the hourly "gone quiet" marking had run in between (closer to live; see docs). Off by default.
// --ignore-incomplete: process every account's backlog even if its current X fetch interval hasn't finished (default: those posts
// wait until it has, so an older page arriving next cycle isn't processed out of chronological order behind a newer one already stored).
const result = await processPending({
  limit,
  onPost,
  from: from && !Number.isNaN(from.getTime()) ? from : null,
  sourceAccount,
  serviceType,
  sweepAsOf: args.includes('--sweep-as-of'),
  ignoreIncomplete: args.includes('--ignore-incomplete') || Boolean(sourceAccount),
});
console.log('\nFINISHED', result, `${freshCalls} fresh Gemini reads, ${((Date.now() - started) / 60000).toFixed(1)} min`);
if (result?.skipped) {
  console.error('Skipped: another worker holds the pipeline lease (the API server or another process.js). No posts were read. An abandoned lease expires after 2 minutes.');
  process.exitCode = 1;
}
{
  const { aiUsage } = await import('../src/modules/ai/gemini.client.js');
  if (aiUsage.calls) console.log(`AI CALLS ${aiUsage.calls} (in ${aiUsage.inputTokens} / out ${aiUsage.outputTokens} tokens)`);
}
await prisma.$disconnect();
