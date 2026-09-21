// One report that measures the engine in separate parts, so a change that helps one cannot hide a loss in another:
//   1. reading      how many posts have an accepted reading (and how many wait for review / failed)
//   2. coverage     how many expected faults ended with exactly one accepted disposition
//   3. grouping     pairwise F1 of every labelled set, split into HOLDOUT (never tuned on) and TUNING/REGRESSION (may be looked at)
//   4. corrections  how many manual corrections the engine now gets right without help (tests/golden/corrections.json)
//   5. final state  how many final-state expectations hold (tests/golden/states.json)
//   node scripts/eval-all.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { faultItems } from '../src/modules/processing/processor.service.js';
import { checkPostDispositions } from '../src/modules/processing/quality.js';

const dir = fileURLToPath(new URL('../tests/golden/', import.meta.url));
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

// 1 + 2: reading and coverage, over every post
const posts = await prisma.sourcePost.findMany({
  select: {
    id: true, processingStatus: true, text: true, noteTweetText: true,
    extractions: { where: { promptVersion: env.AI_PROMPT_VERSION }, orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, result: true, relevance: true } },
    linkDecisions: { select: { faultIndex: true, outcome: true, outageId: true, reason: true } },
    outagePosts: { select: { faultIndex: true, outageId: true } },
  },
});
const replies = posts.filter((p) => /^\s*@\w+/.test(p.noteTweetText || p.text || ''));
const readable = posts.filter((p) => !replies.includes(p));
const by = (s) => readable.filter((p) => p.extractions[0]?.status === s).length;
let expected = 0;
let ok = 0;
for (const p of readable) {
  const e = p.extractions[0];
  if (e?.status !== 'SUCCEEDED') continue;
  const idx = faultItems({ ...e, result: e.result }).map((i) => i.faultIndex);
  expected += idx.length;
  const v = checkPostDispositions({ expectedIndices: idx, decisions: p.linkDecisions, outagePosts: p.outagePosts });
  ok += idx.length - new Set(v.problems.map((m) => /fault (\d+)/.exec(m)?.[1]).filter((x) => x != null)).size;
}
console.log('1. READING   ', `${by('SUCCEEDED')} of ${readable.length} posts have an accepted reading (${pct(by('SUCCEEDED'), readable.length)}); ${by('NEEDS_REVIEW')} need review, ${by('FAILED')} failed  (${replies.length} customer replies skipped)`);
console.log('2. COVERAGE  ', `${ok} of ${expected} expected faults have exactly one accepted disposition (${pct(ok, expected)})`);

// 3: grouping, per set, holdouts apart from the sets that may have been tuned on
console.log('3. GROUPING  (pairwise F1 against hand labels)');
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => /\.json$/.test(x) && !['corrections.json', 'states.json'].includes(x)).sort()) {
  const kind = JSON.parse(fs.readFileSync(dir + f, 'utf8'))._kind ?? 'tuning';
  let out = '';
  try {
    out = execFileSync(process.execPath, ['scripts/eval.js', `--file=${f}`], { encoding: 'utf8', env: process.env });
  } catch (err) {
    out = String(err.stdout ?? '');
  }
  const m = /precision ([\d.]+)%\s+recall ([\d.]+)%\s+F1 ([\d.]+)%/.exec(out);
  const n = /posts labelled: (\d+)/.exec(out)?.[1];
  rows.push({ f, kind, n, p: m?.[1], r: m?.[2], f1: m ? Number(m[3]) : null });
}
for (const kind of ['holdout', 'tuning', 'regression']) {
  const set = rows.filter((r) => r.kind === kind);
  if (!set.length) continue;
  for (const r of set) console.log(`     ${kind.padEnd(10)} ${r.f.padEnd(20)} ${String(r.n).padStart(4)} posts  precision ${r.p}%  recall ${r.r}%  F1 ${r.f1}%`);
  const avg = set.filter((r) => r.f1 != null).reduce((a, r, _, l) => a + r.f1 / l.length, 0);
  console.log(`     ${''.padEnd(10)} ${'average'.padEnd(20)}             F1 ${avg.toFixed(1)}%`);
}

// 4 + 5: corrections and final state
const pairs = execFileSync(process.execPath, ['scripts/eval-pairs.js'], { encoding: 'utf8', env: process.env }).split('\n').filter(Boolean);
const line = (k) => (pairs.find((l) => l.startsWith(k)) ?? '').replace(/^[A-Z ]+: /, '');
console.log(`4. CORRECTIONS ${line('CORRECTIONS')} (manual corrections the engine now gets right)`);
console.log(`5. FINAL STATE ${line('FINAL STATE')} (statuses, kinds and planned windows)`);
for (const l of pairs.filter((x) => x.includes('FAIL'))) console.log(l);
await prisma.$disconnect();
