// Compare extraction models under identical conditions.
//   GEMINI_MODEL=<id> AI_PROMPT_VERSION=<tag> KNOWLEDGE_CONTEXT=off node scripts/model-test.js [--budget=1.0]
// Replays ONLY the test days from an empty learned state, using extractions stored under AI_PROMPT_VERSION.
import { execFileSync } from 'node:child_process';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { infraKey, localityKey } from '../src/lib/normalize.js';
import { processPending, resetLearnedState } from '../src/modules/processing/processor.service.js';

const PRICES = { 'gemini-3.1-flash-lite': [0.25, 1.5], 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.6-flash': [0.75, 3.75] };
const [inP, outP] = PRICES[env.GEMINI_MODEL] ?? [1, 5];
const budget = Number((process.argv.find((a) => a.startsWith('--budget=')) ?? '--budget=1.0').split('=')[1]);

const DAYS = [
  { label: '10 Sep (hold-out)', from: '2026-09-10T00:00:00Z', to: '2026-09-11T00:00:00Z', golden: 'holdout-0910.json' },
  { label: '17 Sep (tuned earlier)', from: '2026-09-17T00:00:00Z', to: '2026-09-18T00:00:00Z', golden: 'links.json' },
];
const costOf = (i, o) => (i * inP + o * outP) / 1e6;

console.log(`MODEL ${env.GEMINI_MODEL}  version ${env.AI_PROMPT_VERSION}  knowledge-context ${env.KNOWLEDGE_CONTEXT}  budget $${budget}\n`);

// This wipes every outage and everything learned about the network first, so it only runs on a throw-away database
// (a name starting gridwatch_test_ or gridwatch_replay_), never on the live one.
const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!/^gridwatch_(test|replay)_/.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" is not a disposable database. Point DATABASE_URL at a copy (see scripts/replay-eval.js --keep), then re-run.`);
  process.exit(1);
}
await resetLearnedState();
const localityKeys = new Set((await prisma.locality.findMany({ select: { canonicalName: true } })).map((l) => localityKey(l.canonicalName)));
const window = { publishedAt: { gte: new Date(DAYS[0].from), lt: new Date(DAYS[0].to) } };
const windows = DAYS.map((d) => ({ publishedAt: { gte: new Date(d.from), lt: new Date(d.to) } }));
const started = Date.now();
let projectedChecked = false;

for (const day of DAYS) {
  console.log(`--- ${day.label}`);
  await processPending({
    from: new Date(day.from),
    to: new Date(day.to),
    onPost: async (res, n, total) => {
      const d = res.detail;
      if (d) console.log(`[${n}/${total}] ${d.relevance}/${d.status} | ${d.tokens} tok | ${res.outcome}`);
      if (!projectedChecked && n === 8) {
        projectedChecked = true;
        const rows = await prisma.postExtraction.aggregate({ where: { promptVersion: env.AI_PROMPT_VERSION }, _sum: { inputTokens: true, outputTokens: true }, _count: true });
        const per = costOf(rows._sum.inputTokens, rows._sum.outputTokens) / rows._count;
        const projected = per * 175;
        console.log(`\n>>> cost so far $${(per * rows._count).toFixed(4)} for ${rows._count} posts -> projected $${projected.toFixed(2)} for ~175 posts\n`);
        if (projected > budget) {
          console.log('>>> PROJECTED COST OVER BUDGET, ABORTING');
          process.exit(2);
        }
      }
    },
  });
}

// ---- extraction quality proxies ----
const ex = await prisma.postExtraction.findMany({
  where: { promptVersion: env.AI_PROMPT_VERSION, post: { OR: windows } },
  select: { status: true, relevance: true, result: true, inputTokens: true, outputTokens: true, durationMs: true, error: true },
});
const ok = ex.filter((e) => e.result);
const JUNK = /^(affected|unknown|customers?|areas?|surrounding|n\/a|none|feeder|line|cable|substation|distributor|[a-z])$/i;
let entities = 0, suburbAsEquipment = 0, junk = 0, locs = 0, matchedLocs = 0;
for (const e of ok) {
  for (const ent of e.result.entities.filter((x) => x.type !== 'SDC')) {
    entities++;
    if (localityKeys.has(localityKey(ent.name)) || localityKeys.has(infraKey(ent.name))) suburbAsEquipment++;
    if (JUNK.test(ent.name.trim())) junk++;
  }
  for (const l of e.result.localities) {
    locs++;
    if (localityKeys.has(localityKey(l.name))) matchedLocs++;
  }
}
const sum = (k) => ex.reduce((a, e) => a + (e[k] ?? 0), 0);
const cost = costOf(sum('inputTokens'), sum('outputTokens'));
console.log('\n===== EXTRACTION SUMMARY =====');
console.log({
  posts: ex.length,
  failed: ex.filter((e) => e.status === 'FAILED').length,
  needsReview: ex.filter((e) => e.status === 'NEEDS_REVIEW').length,
  avgInTokens: Math.round(sum('inputTokens') / ex.length),
  avgOutTokens: Math.round(sum('outputTokens') / ex.length),
  avgSeconds: Number((sum('durationMs') / ex.length / 1000).toFixed(1)),
  costUsd: Number(cost.toFixed(3)),
  costPerPostUsd: Number((cost / ex.length).toFixed(5)),
  equipmentEntities: entities,
  suburbNamedAsEquipment: suburbAsEquipment,
  junkEquipmentNames: junk,
  suburbsNamed: locs,
  suburbsMatchingYourList: matchedLocs,
});

console.log('\n===== LINKING ACCURACY =====');
for (const day of DAYS) {
  console.log(`\n${day.label}`);
  const out = execFileSync('node', ['scripts/eval.js', `--file=${day.golden}`, `--from=${day.from}`, `--to=${day.to}`], { encoding: 'utf8' });
  console.log(out.split('\n').filter((l) => !l.includes('injected') && l.trim()).slice(0, 14).join('\n'));
}
console.log(`\nTOTAL ${((Date.now() - started) / 60000).toFixed(1)} min`);
await prisma.$disconnect();
