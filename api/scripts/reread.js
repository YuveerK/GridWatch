// Re-read posts whose stored reading came from older instructions or another model. Spend-capped, with a backup.
//   npm run reread                  only stale readings (see `npm run audit`)
//   npm run reread -- --all         every post
//   npm run reread -- --max=2.5     spend cap in USD (default 2.5)
//   npm run reread -- --limit=20    only the first N (chronological), handy for a trial
//   npm run reread -- --restore=data/backups/extractions-XXXX.json    put a backup back
// A post whose re-read FAILS keeps its previous reading and summaries. The backup covers readings AND their summaries, and a restore puts both back.
// The whole run holds the pipeline lease, so it cannot overlap a fetch or a linking pass.
// After a re-read, posts whose fault layout changed need relinking (listed at the end):  node scripts/reprocess.js <postId>...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { extractPost, faultLayout, isStale } from '../src/modules/ai/extraction.service.js';
import { PIPELINE, withLease } from '../src/modules/coordination/lease.js';
import { readingRevision } from '../src/lib/reading-revision.js';

const arg = (name, d) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${d}`).split('=').slice(1).join('=');
const MAX_USD = Number(arg('max', 2.5));
const LIMIT = Number(arg('limit', 0));
const CONCURRENCY = Number(arg('concurrency', 4));
const ALL = process.argv.includes('--all');
const RESTORE = arg('restore', '');
const [inP, outP] = env.GEMINI_MODEL.includes('3.5-flash-lite') ? [0.3, 2.5] : [0.75, 3.75];
const pv = env.AI_PROMPT_VERSION;
const FIELDS = ['model', 'status', 'relevance', 'result', 'imageText', 'imageCount', 'inputTokens', 'outputTokens', 'durationMs', 'error'];
const pick = (row) => Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? null]));
const faultsOf = (r) => r?.faults?.length ?? 0;

async function main() {
if (RESTORE) {
  const rows = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
  for (const r of rows) {
    await prisma.$transaction(async (tx) => {
      await tx.postExtraction.update({ where: { postId_promptVersion: { postId: r.postId, promptVersion: pv } }, data: pick(r) });
      if (r.summaries) {
        // the summaries that belonged to that reading come back with it (and any the reading did not have are removed)
        await tx.postSummary.deleteMany({ where: { postId: r.postId } });
        for (const x of r.summaries) await tx.postSummary.create({ data: { postId: r.postId, faultIndex: x.faultIndex, summary: x.summary, model: x.model, promptVersion: x.promptVersion ?? null } });
      }
    });
  }
  console.log(`Restored ${rows.length} readings from ${RESTORE}. Posts whose fault layout differs now need relinking: node scripts/reprocess.js <postId>...`);
  return;
}

const rows = await prisma.postExtraction.findMany({ where: { promptVersion: pv }, include: { post: { select: { publishedAt: true } } } });
const todo = rows
  .filter((r) => ALL || isStale(r))
  .sort((a, b) => a.post.publishedAt - b.post.publishedAt)
  .slice(0, LIMIT || undefined);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const backup = path.join(dir, `extractions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const summaryRows = await prisma.postSummary.findMany({ orderBy: [{ postId: 'asc' }, { faultIndex: 'asc' }] });
const summariesOf = new Map();
for (const x of summaryRows) summariesOf.set(x.postId, [...(summariesOf.get(x.postId) ?? []), { faultIndex: x.faultIndex, summary: x.summary, model: x.model, promptVersion: x.promptVersion }]);
fs.writeFileSync(backup, JSON.stringify(rows.map((r) => ({ postId: r.postId, ...pick(r), summaries: summariesOf.get(r.postId) ?? [] }))));
console.log(`Backup of ${rows.length} readings: ${backup}`);
console.log(`Model ${env.GEMINI_MODEL}: re-reading ${todo.length} of ${rows.length} posts, ${CONCURRENCY} at a time, spend cap $${MAX_USD}\n`);

const old = new Map(rows.map((r) => [r.postId, r]));
let next = 0;
let done = 0;
let spent = 0;
let stopped = false;
const stat = { failed: 0, relevanceChanged: 0, faultsChanged: 0, restoredOld: 0 };
const needRelink = [];
const started = Date.now();

async function worker() {
  while (!stopped) {
    const i = next++;
    if (i >= todo.length) return;
    const before = old.get(todo[i].postId);
    let out;
    try {
      out = await extractPost(before.postId, { force: true });
    } catch (err) {
      out = { status: 'FAILED', error: err.message };
    }
    spent += ((out.inputTokens ?? 0) * inP + (out.outputTokens ?? 0) * outP) / 1e6;
    if (out.status === 'FAILED' || out.keptAfterFailure) {
      stat.failed++; // extractPost kept the previous reading and its summaries
      stat.restoredOld++;
    } else {
      if (out.relevance !== before.relevance) stat.relevanceChanged++;
      if (faultsOf(out.result) !== faultsOf(before.result)) stat.faultsChanged++;
      // ANY change that can alter what the engine does (status, percentage, cause, estimate, equipment, suburbs, per-fault details), not only the fault count or class
      if (readingRevision(out.result) !== readingRevision(before.result) || faultLayout(out.result) !== faultLayout(before.result) || out.relevance !== before.relevance) needRelink.push(before.postId);
    }
    done++;
    if (done % 10 === 0 || done === todo.length) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${done}/${todo.length}] ${mins} min | spent $${spent.toFixed(3)} | changed reading: ${stat.relevanceChanged} | faults split differently: ${stat.faultsChanged} | failed (kept old): ${stat.failed}`);
    }
    if (spent > MAX_USD) {
      stopped = true;
      console.log('SPEND CAP REACHED, STOPPING');
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\nDONE. Re-read ${done} posts, spent $${spent.toFixed(3)}. ${stat.relevanceChanged} were classified differently, ${stat.faultsChanged} split into a different number of faults, ${stat.failed} failed and kept their old reading.`);
if (needRelink.length) console.log(`${needRelink.length} posts have a reading that differs in something the engine uses (their existing links and effects refer to the old reading):
  node scripts/reprocess.js ${needRelink.join(' ')}`);
}

const held = await withLease(PIPELINE, () => main(), { ttlMs: 120_000 });
if (!held.acquired) console.error('Another worker holds the pipeline lease (a fetch or refresh is running). Try again when it has finished.');
await prisma.$disconnect();
