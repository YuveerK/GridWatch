// Check every stored correction (tests/golden/corrections.json) and every final-state expectation (tests/golden/states.json) against the database.
//   node scripts/eval-pairs.js            report
//   node scripts/eval-pairs.js --strict   exit 1 if any pair or state fails (or cannot be judged)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { checkState, evaluatePairs } from '../src/modules/outages/corrections.js';

const load = (name) => {
  const f = fileURLToPath(new URL(`../tests/golden/${name}`, import.meta.url));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
const corrections = load('corrections.json')?.pairs ?? [];
const states = load('states.json')?.states ?? [];

const ids = [...new Set([...corrections.flatMap((p) => [p.a, p.b]), ...states.map((s) => s.post)])];
const posts = await prisma.sourcePost.findMany({
  where: { externalId: { in: ids } },
  select: { externalId: true, outagePosts: { select: { faultIndex: true, outageId: true, outage: { select: { id: true, title: true, kind: true, status: true, scheduledStart: true, scheduledEnd: true, _count: { select: { posts: true } } } } } } },
});
const byId = new Map(posts.map((p) => [p.externalId, p]));
const outagesOf = (externalId, fault) => {
  const p = byId.get(externalId);
  return p ? new Set(p.outagePosts.filter((o) => fault == null || o.faultIndex === fault).map((o) => o.outageId)) : null;
};

let bad = 0;
const pairs = evaluatePairs(corrections, outagesOf);
console.log(`CORRECTIONS: ${pairs.passed.length} of ${corrections.length} hold`);
for (const f of [...pairs.failed, ...pairs.unknown]) {
  bad += 1;
  console.log(`  FAIL ${f.pair.same ? 'same' : 'different'} ${f.pair.a.slice(-8)} / ${f.pair.b.slice(-8)}: ${f.reason}  (${f.pair.why})`);
}

let stateOk = 0;
for (const s of states) {
  const p = byId.get(s.post);
  const op = p?.outagePosts.find((o) => s.fault == null || o.faultIndex === s.fault);
  const outage = op ? { ...op.outage, postCount: op.outage._count.posts } : null;
  const problems = p ? checkState(s, outage) : [`post ${s.post} not found`];
  if (problems.length) {
    bad += 1;
    console.log(`  FAIL state ${s.post.slice(-8)}${s.fault != null ? `#${s.fault}` : ''}: ${problems.join('; ')}  (${s.why})`);
  } else stateOk += 1;
}
console.log(`FINAL STATE: ${stateOk} of ${states.length} hold`);
await prisma.$disconnect();
process.exit(process.argv.includes('--strict') && bad ? 1 : 0);
