// Re-read posts whose stored reading came from older instructions or another model. Spend-capped, with a backup.
//   npm run reread                  only stale readings (see `npm run audit`)
//   npm run reread -- --all         every post
//   npm run reread -- --max=2.5     spend cap in USD (default 2.5)
//   npm run reread -- --limit=20    only the first N (chronological), handy for a trial
//   npm run reread -- --restore=data/backups/extractions-XXXX.json    put a backup back
// A post whose re-read FAILS keeps its previous reading. After a re-read, rebuild the outages:  node scripts/process.js --reset
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { extractPost, isStale } from '../src/modules/ai/extraction.service.js';

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

if (RESTORE) {
  const rows = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
  for (const r of rows) await prisma.postExtraction.update({ where: { postId_promptVersion: { postId: r.postId, promptVersion: pv } }, data: pick(r) });
  console.log(`Restored ${rows.length} readings from ${RESTORE}. Now rebuild outages: node scripts/process.js --reset`);
  await prisma.$disconnect();
  process.exit(0);
}

const rows = await prisma.postExtraction.findMany({ where: { promptVersion: pv }, include: { post: { select: { publishedAt: true } } } });
const todo = rows
  .filter((r) => ALL || isStale(r))
  .sort((a, b) => a.post.publishedAt - b.post.publishedAt)
  .slice(0, LIMIT || undefined);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const backup = path.join(dir, `extractions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(backup, JSON.stringify(rows.map((r) => ({ postId: r.postId, ...pick(r) }))));
console.log(`Backup of ${rows.length} readings: ${backup}`);
console.log(`Model ${env.GEMINI_MODEL}: re-reading ${todo.length} of ${rows.length} posts, ${CONCURRENCY} at a time, spend cap $${MAX_USD}\n`);

const old = new Map(rows.map((r) => [r.postId, r]));
let next = 0;
let done = 0;
let spent = 0;
let stopped = false;
const stat = { failed: 0, relevanceChanged: 0, faultsChanged: 0, restoredOld: 0 };
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
    if (out.status === 'FAILED') {
      stat.failed++;
      await prisma.postExtraction.update({ where: { postId_promptVersion: { postId: before.postId, promptVersion: pv } }, data: pick(before) });
      stat.restoredOld++;
    } else {
      if (out.relevance !== before.relevance) stat.relevanceChanged++;
      if (faultsOf(out.result) !== faultsOf(before.result)) stat.faultsChanged++;
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
console.log('Next: node scripts/process.js --reset   (rebuilds outages from the fresh readings)');
await prisma.$disconnect();
