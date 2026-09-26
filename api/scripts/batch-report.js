// Audit the newest fetch: did the pipeline run correctly, and does each post's result look sane?
//   npm run batch            latest batch that brought posts
//   npm run batch -- --all   also list posts that raised no concern
//   npm run batch -- --runs=2   cover the last 2 fetches that brought posts
//   npm run batch -- --since-checkpoint   every post that arrived since the last such check, then move the mark to now
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { readerFor } from '../src/modules/ai/reader-registry.js';
import { isThrottlingSchedule, statusBoardFaults, waterFaultItems } from '../src/modules/ai/readers/water.reader.js';
import { faultItems } from '../src/modules/processing/processor.service.js';
import { awaitingReview, checkPostDispositions, effectReadingMismatch, ingestionProblems, latestNonemptyRuns, stuckProcessing } from '../src/modules/processing/quality.js';

const all = process.argv.includes('--all');
const sinceCheckpoint = process.argv.includes('--since-checkpoint');
const RUNS = Number((process.argv.find((a) => a.startsWith('--runs=')) ?? '--runs=1').split('=')[1]);
const short = (t, n = 150) => (t ?? '').replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const checkpointFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'check-checkpoint.json');
const SAST = 2 * 3_600_000;
const startOfTodaySast = (now) => {
  const shifted = new Date(now.getTime() + SAST);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SAST);
};
const readCheckpoint = () => {
  try {
    const at = new Date(JSON.parse(readFileSync(checkpointFile, 'utf8')).checkedAt);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
};
const PRICE = { 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.1-flash-lite': [0.25, 1.5], 'gemini-3.6-flash': [0.75, 3.75] };

const now = new Date();
const savedCheckpoint = sinceCheckpoint ? readCheckpoint() : null;
const windowStart = sinceCheckpoint ? (savedCheckpoint ?? startOfTodaySast(now)) : null;
if (sinceCheckpoint) console.log(`CHECKPOINT  ${savedCheckpoint ? 'since the last check' : 'no earlier check, so since midnight SAST'}  ${windowStart.toISOString()} -> ${now.toISOString()}`);

const runs = sinceCheckpoint ? [] : await prisma.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 12, include: { SourceAccount: { select: { displayName: true, serviceType: true } } } });
const withPosts = sinceCheckpoint ? [] : await latestNonemptyRuns(prisma, RUNS); // found directly: however many empty polls came after them
const active = sinceCheckpoint ? [] : await prisma.sourceAccount.findMany({ where: { active: true }, select: { id: true, displayName: true, serviceType: true } });
for (const account of active) {
  const latest = await prisma.ingestionRun.findFirst({ where: { sourceAccountId: account.id, postsInserted: { gt: 0 } }, orderBy: { startedAt: 'desc' } });
  if (latest && !withPosts.some((run) => run.id === latest.id)) withPosts.push(latest);
}
const batch = sinceCheckpoint ? { startedAt: windowStart } : withPosts.at(-1);
if (!sinceCheckpoint) console.log('RECENT FETCH RUNS');
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(5, 19)}  ${(r.SourceAccount?.displayName ?? '').padEnd(14)} ${r.status.padEnd(10)} fetched ${String(r.postsFetched).padStart(3)}  inserted ${String(r.postsInserted).padStart(3)}${r.errorMessage ? `  ERROR ${r.errorMessage.slice(0, 70)}` : ''}${withPosts.some((w) => w.id === r.id) ? '   <-- audited' : ''}`);
for (const w of withPosts) if (!runs.some((r) => r.id === w.id)) console.log(`  ${w.startedAt.toISOString().slice(5, 19)}  ${w.status.padEnd(10)} fetched ${String(w.postsFetched).padStart(3)}  inserted ${String(w.postsInserted).padStart(3)}   <-- audited (older than the list above)`);
if (!sinceCheckpoint && !withPosts.length) {
  console.log('\nNo fetch has ever brought new posts.');
  await prisma.$disconnect();
  process.exit(1); // nothing to audit is not "all fine"
}

// The exact posts these runs inserted (recorded per run). Runs from before that was recorded fall back to the time window.
const runIds = withPosts.map((r) => r.id);
const recorded = sinceCheckpoint || !runIds.length ? 0 : await prisma.ingestionRunPost.count({ where: { ingestionRunId: { in: runIds } } });
const posts = await prisma.sourcePost.findMany({
  where: sinceCheckpoint ? { createdAt: { gt: windowStart, lte: now } } : recorded ? { IngestionRunPost: { some: { ingestionRunId: { in: runIds } } } } : { createdAt: { gte: batch.startedAt, ...(batch.completedAt ? { lte: batch.completedAt } : {}) } },
  orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
  include: {
    extractions: { orderBy: { createdAt: 'desc' } },
    linkDecisions: { orderBy: { faultIndex: 'asc' }, include: { outage: { select: { id: true, title: true, status: true, kind: true, restoredAt: true, restorationPercent: true, createdAt: true, _count: { select: { posts: true } } } } } },
    outagePosts: { select: { faultIndex: true, outageId: true, effect: true } },
    summaries: true,
    PostMedia: { select: { id: true } },
  },
});

const checks = [];
const check = (name, bad, detail = '') => checks.push({ name, bad, detail });
const flagged = new Map(); // post id -> reasons
const flag = (post, why) => flagged.set(post.externalId, [...(flagged.get(post.externalId) ?? []), why]);

let inTok = 0;
let outTok = 0;
const model = new Set();
const newOutageIds = new Set();

for (const x of posts) {
  const promptVersion = readerFor(x.serviceType ?? 'ELECTRICITY').promptVersion ?? env.AI_PROMPT_VERSION;
  const e = x.extractions.find((extraction) => extraction.promptVersion === promptVersion);
  const r = e?.result;
  if (e) {
    inTok += e.inputTokens ?? 0;
    outTok += e.outputTokens ?? 0;
    model.add(e.model);
  }
  const text = x.noteTweetText || x.text;
  // a water status board is split in code (statusBoardFaults): its problem assets are what must be linked, whatever the reading said;
  // the daily throttling schedule is always a notice (isThrottlingSchedule), so it has nothing to link
  const board = x.serviceType === 'WATER' && r ? (isThrottlingSchedule(r) ? [] : statusBoardFaults(r)) : null;
  const linkable = board ? board.length > 0 : r && ['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE'].includes(r.relevance);
  const faults = board ?? r?.faults ?? [];
  const multi = faults.length >= 2 || (faults.length === 1 && (board || r?.relevance === 'SDC_SUMMARY'));

  if (!e || e.status !== 'SUCCEEDED') flag(x, `extraction ${e?.status ?? 'missing'}${e?.error ? `: ${e.error.slice(0, 60)}` : ''}`);
  if (x.processingStatus === 'UNPROCESSED' || x.processingStatus === 'PROCESSING' || x.processingStatus === 'PROCESSING_ERROR') flag(x, `status ${x.processingStatus}`);
  if (x.processingStatus === 'NEEDS_REVIEW') flag(x, 'needs review');
  if (text.trim().startsWith('@')) flag(x, 'customer reply was fetched');
  if (x.linkDecisions.length === 0) flag(x, 'no link decision');
  // EVERY expected fault of the current reading must have exactly one disposition, a linked one its timeline entry, and a left-out one a reason
  if (e?.status === 'SUCCEEDED' && r) {
    const items = (x.serviceType === 'WATER' ? waterFaultItems : faultItems)({ ...e, result: r });
    const verdict = checkPostDispositions({ expectedIndices: items.map((i) => i.faultIndex), decisions: x.linkDecisions, outagePosts: x.outagePosts });
    for (const p of verdict.problems) flag(x, `disposition: ${p}`);
    // another service's content is set aside on purpose (the quality check agrees: quality.js checkPostDispositions)
    for (const d of verdict.excluded) if (linkable && !/unsupported service/i.test(d.reason ?? '')) flag(x, `fault ${d.faultIndex} produced no outage (${d.reason})`);
    for (const op of x.outagePosts) if (effectReadingMismatch(op.effect, r)) flag(x, `timeline entry for fault ${op.faultIndex} was built from a different reading than the current one (re-link it)`);
  }
  const offService = x.linkDecisions.some((d) => /unsupported service/i.test(d.reason ?? ''));
  if (linkable && x.outagePosts.length === 0 && !multi && !offService) flag(x, 'outage-type post but linked to no outage');
  if (linkable || multi) {
    if (!x.summaries.length) flag(x, 'no summary written');
    for (const s of x.summaries) if (s.summary.length < 25 || s.summary.length > 260) flag(x, `odd summary length (${s.summary.length})`);
  }

  // each fault of a multi-fault graphic must be its own outage
  if (multi) {
    const ids = x.linkDecisions.filter((d) => d.outageId).map((d) => d.outageId);
    if (new Set(ids).size < ids.length) flag(x, 'two faults of one graphic share an outage');
  }
  for (const d of x.linkDecisions) {
    const o = d.outage;
    if (!o) continue;
    if (o.createdAt >= batch.startedAt) newOutageIds.add(o.id);
    if (o.restorationPercent != null && o.restorationPercent < 100 && o.status === 'RESTORED') flag(x, `outage "${o.title}" is RESTORED at ${o.restorationPercent}%`);
    if ((o.status === 'RESTORED' || o.status === 'CLOSED') && !o.restoredAt && o.kind === 'UNPLANNED' && o.status === 'RESTORED') flag(x, `outage "${o.title}" restored without a time`);
    if (/^(no\.?\s*\d+|\d+[a-z]?|unknown|unspecified|affected)\b/i.test(o.title)) flag(x, `weak outage title "${o.title}"`);
    if (d.outcome === 'NEEDS_REVIEW') flag(x, `link needs review: ${d.reason}`);
  }
}

check('every post extracted successfully', posts.filter((x) => x.extractions[0]?.status !== 'SUCCEEDED').length);
check('every post processed (none stuck)', posts.filter((x) => ['UNPROCESSED', 'PROCESSING', 'PROCESSING_ERROR'].includes(x.processingStatus)).length);
check('no customer replies fetched (they cost money and are unused)', posts.filter((x) => (x.noteTweetText || x.text).trim().startsWith('@')).length);
check('every post has a link decision', posts.filter((x) => x.linkDecisions.length === 0).length);
check('every expected fault has exactly one accepted disposition', [...flagged.values()].flat().filter((w) => w.startsWith('disposition:')).length);
check('no linkable fault silently produced no outage', [...flagged.values()].flat().filter((w) => /produced no outage/.test(w)).length);
check('every timeline entry was built from the current reading', [...flagged.values()].flat().filter((w) => /different reading/.test(w)).length);check('faults of one graphic never share an outage', [...flagged.values()].flat().filter((w) => w.startsWith('two faults')).length);
check('no outage marked RESTORED while a percentage below 100 is stated', [...flagged.values()].flat().filter((w) => w.includes('is RESTORED at')).length);
check('outage-type posts are linked to an outage', [...flagged.values()].flat().filter((w) => w.startsWith('outage-type post')).length);
check('summaries written and sensible', [...flagged.values()].flat().filter((w) => /summary/.test(w)).length);
check('no weak outage titles', [...flagged.values()].flat().filter((w) => w.startsWith('weak outage title')).length);
const openItems = await prisma.reviewItem.findMany({ where: { postId: { in: posts.map((x) => x.id) }, status: 'OPEN' }, select: { postId: true, sampled: true, reasons: true } });
for (const i of openItems) if (!i.sampled) flag(posts.find((x) => x.id === i.postId), `open review item: ${(i.reasons ?? []).map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join(', ')}`);
check('nothing waiting for human review', awaitingReview(posts, openItems).length);

// database-wide invariants (the same ones `npm run audit` checks, scoped to what this batch touched)
const touched = [...new Set(posts.flatMap((x) => x.linkDecisions.map((d) => d.outageId).filter(Boolean)))];
const outs = await prisma.outage.findMany({ where: { id: { in: touched } }, include: { localities: true } });
check('touched outages: none live with every suburb restored', outs.filter((o) => ['ACTIVE', 'PARTIALLY_RESTORED'].includes(o.status) && o.localities.length && o.localities.every((l) => l.restored)).length);
check('touched outages: none restored with an unrestored suburb', outs.filter((o) => o.status === 'RESTORED' && o.localities.some((l) => !l.restored)).length);

const [inP, outP] = PRICE[[...model][0]] ?? [0.3, 2.5];
const gemini = (inTok * inP + outTok * outP) / 1e6;
const xCost = posts.length * 0.005;

console.log(posts.length ? `\nBATCH: ${posts.length} posts from ${posts[0].publishedAt.toISOString().slice(5, 16)} to ${posts.at(-1).publishedAt.toISOString().slice(5, 16)} (UTC)` : '\nBATCH: 0 posts');
const by = (k) => posts.reduce((a, x) => ((a[k(x)] = (a[k(x)] ?? 0) + 1), a), {});
console.log('  read as   :', JSON.stringify(by((x) => x.extractions[0]?.result?.relevance ?? 'none')));
console.log('  outcome   :', JSON.stringify(by((x) => x.processingStatus)));
console.log(`  outages   : ${newOutageIds.size} new, ${touched.length - newOutageIds.size} updated | LLM tie-breaks: ${posts.flatMap((x) => x.linkDecisions).filter((d) => d.usedLlm).length}`);
console.log(`  cost      : X $${xCost.toFixed(3)} + Gemini $${gemini.toFixed(4)} (${model.size ? [...model].join(',') : 'n/a'}) = $${(xCost + gemini).toFixed(3)}  ($${posts.length ? ((xCost + gemini) / posts.length).toFixed(4) : 0}/post)`);

console.log('\nAUTOMATIC CHECKS');
let failed = 0;
for (const c of checks) {
  if (c.bad) failed++;
  console.log(`  ${c.bad ? 'FAIL' : 'ok  '}  ${c.name}${c.bad ? `  (${c.bad})` : ''}`);
}

console.log('\nPOST BY POST');
for (const x of posts) {
  const why = flagged.get(x.externalId);
  if (!all && !why) continue;
  const r = x.extractions[0]?.result;
  console.log(`\n${why ? '!! ' : '   '}${x.publishedAt.toISOString().slice(5, 16)} ${x.externalId.slice(-6)} [${r?.relevance ?? '?'}/${r?.status ?? '?'}]  ${short(x.noteTweetText || x.text, 110)}`);
  if (why) console.log(`     CONCERN: ${why.join('; ')}`);
  for (const d of x.linkDecisions) {
    const s = x.summaries.find((y) => y.faultIndex === d.faultIndex)?.summary;
    console.log(`     ${d.faultIndex ? `#${d.faultIndex} ` : ''}${(d.outcome === 'NEW' && d.outage ? 'OPENED' : d.outcome).padEnd(7)} -> ${d.outage ? `${d.outage.title} [${d.outage.status}${d.outage.restorationPercent != null ? ` ${d.outage.restorationPercent}%` : ''}]` : `(${(d.reason ?? '').slice(0, 40)})`}${d.usedLlm ? ' (tie-break)' : ''}`);
    if (s) console.log(`         "${s.slice(0, 140)}"`);
  }
}
if (!all) console.log(`\n(${posts.length - flagged.size} posts raised no concern; use --all to list them)`);
// the fetch and processing state around this batch - every active account, not just the env-configured default, so a stale or
// missing checkpoint on a secondary account (e.g. Tshwane) isn't invisible while the default account looks healthy
const accounts = await prisma.sourceAccount.findMany({ where: { active: true } });
const ingest = accounts.length
  ? (await Promise.all(accounts.map(async (a) => ingestionProblems(await prisma.ingestionState.findUnique({ where: { accountId: a.externalId } })).map((p) => `${a.displayName}: ${p}`)))).flat()
  : ingestionProblems(await prisma.ingestionState.findUnique({ where: { accountId: env.X_SOURCE_ACCOUNT_ID } }));
const stuck = stuckProcessing(await prisma.sourcePost.findMany({ where: { processingStatus: 'PROCESSING' }, select: { processingStatus: true, processingStartedAt: true } }));
const degraded = [...ingest, ...(stuck.length ? [`${stuck.length} post(s) stuck in PROCESSING`] : [])];
for (const d of degraded) console.log(`DEGRADED: ${d}`);
console.log(`\nRESULT: ${failed > 0 ? `${failed} CHECK(S) FAILED` : degraded.length ? 'DEGRADED' : 'PIPELINE OK'} | ${flagged.size} post(s) flagged for a closer look`);
if (sinceCheckpoint) {
  const activeAccounts = await prisma.sourceAccount.findMany({ where: { active: true }, select: { displayName: true, serviceType: true } });
  // every active account by service, so the report shows each one was covered - not only the ones that stayed quiet
  console.log('BY SOURCE');
  for (const a of [...activeAccounts].sort((l, r) => l.serviceType.localeCompare(r.serviceType) || l.displayName.localeCompare(r.displayName))) {
    const own = posts.filter((p) => p.sourceAccount === a.displayName);
    const ownFlagged = own.filter((p) => flagged.has(p.externalId)).length;
    console.log(`  ${a.serviceType.padEnd(11)} ${a.displayName.padEnd(14)} ${own.length ? `${own.length} post(s), ${ownFlagged} flagged` : 'no new posts'}`);
  }
  for (const p of posts) if (!activeAccounts.some((a) => a.displayName === p.sourceAccount)) console.log(`  ${p.serviceType.padEnd(11)} ${p.sourceAccount.padEnd(14)} post ${p.externalId} from an account that is not active`);
  mkdirSync(path.dirname(checkpointFile), { recursive: true });
  writeFileSync(checkpointFile, `${JSON.stringify({ checkedAt: now.toISOString() }, null, 2)}\n`);
  console.log(`Checkpoint moved to ${now.toISOString()}`);
}
await prisma.$disconnect();
process.exit(failed ? 1 : degraded.length ? 2 : 0); // 1 = checks failed, 2 = degraded (incomplete, stuck or stale), 0 = fine
