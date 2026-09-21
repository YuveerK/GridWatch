// Replay the whole pipeline on a THROW-AWAY database and score it against the golden sets. Safe by construction:
//   - the source database (DATABASE_URL) is only READ: posts, stored readings and geography are copied out of it;
//   - everything else happens in a new database `gridwatch_replay_<time>` that is dropped at the end (--keep to inspect it);
//   - GRIDWATCH_NO_AI=1 in the child processes: stored readings and cached tie-break verdicts are used, nothing is ever sent to the AI provider,
//     and a tie-break that is not in the cache becomes NEEDS_REVIEW (counted in the report, not guessed);
//   - X is never contacted (no ingestion runs).
//   node scripts/replay-eval.js [--keep]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
// --tiebreaks lets the replay pay for the small "same fault or not?" questions it has no cached answer for (never post readings; at most 80 calls).
const tiebreaks = process.argv.includes('--tiebreaks');
const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is not set');

const withDatabase = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  u.search = '';
  return u.toString();
};
const name = `gridwatch_replay_${Date.now()}_${randomBytes(3).toString('hex')}`;
const target = withDatabase(source, name);
const admin = new PrismaClient({ datasourceUrl: withDatabase(source, 'postgres') });
const run = (args, extraEnv = {}) => spawnSync(process.execPath, args, { cwd: API, env: { ...process.env, DATABASE_URL: target, ...(tiebreaks ? { GRIDWATCH_NO_AI: '', GRIDWATCH_AI_ONLY: 'tiebreak', GRIDWATCH_AI_MAX_CALLS: process.env.GRIDWATCH_AI_MAX_CALLS || '80' } : { GRIDWATCH_NO_AI: '1' }), SCHEDULER: 'off', LOG_LEVEL: 'silent', ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const migrate = run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  if (migrate.status !== 0) throw new Error(`migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);

  // read-only copy of what the replay needs
  const src = new PrismaClient({ datasourceUrl: source });
  const dst = new PrismaClient({ datasourceUrl: target });
  const chunks = (a, n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
  const copy = async (label, rows, create) => {
    for (const c of chunks(rows)) await create(c);
    console.log(`copied ${rows.length} ${label}`);
  };
  await copy('regions', await src.region.findMany(), (data) => dst.region.createMany({ data }));
  await copy('suburbs', await src.locality.findMany(), (data) => dst.locality.createMany({ data }));
  await copy('suburb aliases', await src.localityAlias.findMany(), (data) => dst.localityAlias.createMany({ data }));
  await copy('posts', await src.sourcePost.findMany({ orderBy: { publishedAt: 'asc' } }), (data) => dst.sourcePost.createMany({ data: data.map((p) => ({ ...p, processingStatus: 'UNPROCESSED', processingStartedAt: null, publicMetrics: p.publicMetrics ?? undefined, attachments: p.attachments ?? undefined, rawPayload: p.rawPayload ?? undefined })) }));
  await copy('post media', await src.postMedia.findMany(), (data) => dst.postMedia.createMany({ data }));
  await copy('stored readings', await src.postExtraction.findMany(), (data) => dst.postExtraction.createMany({ data: data.map((r) => ({ ...r, result: r.result ?? undefined })) }));
  await src.$disconnect();
  await dst.$disconnect();

  const proc = run(['scripts/process.js']);
  const tail = proc.stdout.trim().split('\n').slice(-3).join('\n');
  console.log(`\nreplay finished (exit ${proc.status}):\n${tail}${proc.stderr ? `\nstderr: ${proc.stderr.slice(0, 500)}` : ''}`);

  const db = new PrismaClient({ datasourceUrl: target });
  const decisions = await db.linkDecision.groupBy({ by: ['outcome'], _count: true });
  const review = await db.linkDecision.count({ where: { outcome: 'NEEDS_REVIEW' } });
  const uncached = await db.linkDecision.count({ where: { reason: { startsWith: 'tie-break failed' } } });
  console.log('link decisions:', Object.fromEntries(decisions.map((d) => [d.outcome, d._count])), `| needs review: ${review} (uncached tie-breaks: ${uncached})`);
  console.log('outages:', await db.outage.count());
  await db.$disconnect();

  for (const file of ['links.json', 'holdout-0910.json', 'holdout-0911.json', 'holdout-0912.json', 'holdout-0914.json', 'holdout-0915.json', 'cases-0921.json']) {
    const ev = run(['scripts/eval.js', `--file=${file}`]);
    console.log(`\n=== ${file} ===\n${ev.stdout.trim()}${ev.status ? `\n(exit ${ev.status}) ${ev.stderr.slice(0, 300)}` : ''}`);
  }
  // The stored manual corrections and final-state expectations, WITHOUT the manual overrides (a replay never copies them): what the engine gets right on its own.
  const pairs = run(['scripts/eval-pairs.js']);
  console.log(`\n=== corrections and final state, without manual help ===\n${pairs.stdout.trim()}`);
} finally {
  if (keep) console.log(`\nkept database ${name}`);
  else {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    console.log(`\ndropped ${name}`);
  }
  await admin.$disconnect();
}
