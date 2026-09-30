// One report that measures the engine in separate parts, so a change that helps one cannot hide a loss in another:
//   1. reading      how many posts have an accepted reading (and how many wait for review / failed)
//   2. coverage     how many expected faults ended with exactly one accepted disposition
//   3. grouping     pairwise F1 of every labelled set, split into HOLDOUT (never tuned on) and TUNING/REGRESSION (may be looked at)
//   4. corrections  how many correction expectations hold in this database (including manual overrides)
//   5. final state  how many final-state expectations hold (tests/golden/states.json)
//   node scripts/eval-all.js
//   node scripts/eval-all.js --details   list every post with disposition inconsistencies
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { faultItems } from '../src/modules/processing/processor.service.js';
import { checkPostDispositions, dispositionCoverage, readingFaultItems } from '../src/modules/processing/quality.js';
import { readerFor } from '../src/modules/ai/reader-registry.js';
import { checkWaterReviewCases, isPairwiseGroupingFile } from '../src/lib/golden-sets.js';

const dir = fileURLToPath(new URL('../tests/golden/', import.meta.url));
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

// 1 + 2: reading and coverage, over every post
const posts = await prisma.sourcePost.findMany({
  select: {
    id: true, externalId: true, sourceAccount: true, publishedAt: true, serviceType: true, processingStatus: true, text: true, noteTweetText: true,
    extractions: { orderBy: { createdAt: 'desc' }, select: { promptVersion: true, status: true, result: true, relevance: true } },
    linkDecisions: { select: { faultIndex: true, outcome: true, outageId: true, reason: true } },
    outagePosts: { select: { faultIndex: true, outageId: true } },
  },
});
const replies = posts.filter((p) => /^\s*@\w+/.test(p.noteTweetText || p.text || ''));
const readable = posts.filter((p) => !replies.includes(p));
const current = (p) => p.extractions.find((e) => e.promptVersion === (readerFor(p.serviceType).promptVersion ?? env.AI_PROMPT_VERSION));
const by = (s) => readable.filter((p) => current(p)?.status === s).length;
let expected = 0;
let ok = 0;
const affected = [];
const coverageBySource = new Map();
for (const p of readable) {
  const e = current(p);
  if (e?.status !== 'SUCCEEDED') continue;
  const idx = readingFaultItems(p, e, faultItems).map((i) => i.faultIndex);
  const coverage = dispositionCoverage({ expectedIndices: idx, decisions: p.linkDecisions, outagePosts: p.outagePosts });
  expected += coverage.expected;
  ok += coverage.accepted;
  const key = `${p.serviceType} ${p.sourceAccount}`;
  const totals = coverageBySource.get(key) ?? { expected: 0, accepted: 0, missing: 0, invalid: 0, unexpected: 0, affected: 0 };
  totals.expected += coverage.expected;
  totals.accepted += coverage.accepted;
  totals.missing += coverage.missingIndices.length;
  totals.invalid += coverage.invalidIndices.length;
  totals.unexpected += coverage.unexpectedIndices.length;
  const v = checkPostDispositions({ expectedIndices: idx, decisions: p.linkDecisions, outagePosts: p.outagePosts });
  if (v.problems.length) {
    totals.affected += 1;
    affected.push({ post: p, problems: v.problems });
  }
  coverageBySource.set(key, totals);
}
console.log('1. READING   ', `${by('SUCCEEDED')} of ${readable.length} posts have an accepted reading (${pct(by('SUCCEEDED'), readable.length)}); ${by('NEEDS_REVIEW')} need review, ${by('FAILED')} failed  (${replies.length} customer replies skipped)`);
console.log('2. COVERAGE  ', `${ok} of ${expected} expected faults have exactly one accepted disposition (${pct(ok, expected)})`);
for (const [source, counts] of [...coverageBySource].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`     ${source}: ${counts.accepted}/${counts.expected} accepted; ${counts.missing} missing, ${counts.invalid} invalid, ${counts.unexpected} unexpected fault indices; ${counts.affected} affected posts`);
}
console.log('     Structural coverage only; unexpected indices are separate consistency problems, not missing expected faults.');
if (affected.length) {
  affected.sort((a, b) => b.post.publishedAt - a.post.publishedAt || a.post.externalId.localeCompare(b.post.externalId));
  const shown = process.argv.includes('--details') ? affected : affected.slice(0, 5);
  console.log(`     DISPOSITION PROBLEMS: ${affected.length} posts (showing ${shown.length}${shown.length < affected.length ? '; use --details for all' : ''})`);
  for (const { post, problems } of shown) {
    console.log(`       ${post.publishedAt.toISOString()} ${post.serviceType} ${post.sourceAccount} ${post.externalId} (postId ${post.id})`);
    for (const problem of problems) console.log(`         ${problem}`);
  }
}

// 3: grouping, per set, holdouts apart from the sets that may have been tuned on
console.log('3. GROUPING  (pairwise F1 against hand labels)');
console.log('     Stored assignments, including manual overrides; these scores do not measure unassisted replay or image-reading accuracy.');
const rows = [];
const waterReview = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const parsed = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
  if (f === 'water-reviews.json' || parsed?._kind === 'water-review' || Array.isArray(parsed)) {
    if (f === 'water-reviews.json' || parsed?._kind === 'water-review') waterReview.push(checkWaterReviewCases(parsed));
    continue;
  }
  if (!isPairwiseGroupingFile(f, parsed)) continue;
  const kind = parsed._kind ?? 'tuning';
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
const review = waterReview.reduce((a, r) => ({ cases: a.cases + r.cases, passed: a.passed + r.passed, failed: a.failed + r.failed }), { cases: 0, passed: 0, failed: 0 });

// 4 + 5: corrections and final state
const pairs = execFileSync(process.execPath, ['scripts/eval-pairs.js'], { encoding: 'utf8', env: process.env }).split('\n').filter(Boolean);
const line = (k) => (pairs.find((l) => l.startsWith(k)) ?? '').replace(/^[A-Z ]+: /, '');
console.log(`4. CORRECTIONS ${line('CORRECTIONS')} (stored database, including manual overrides; not an unassisted replay)`);
console.log('WATER REVIEW REGRESSIONS');
console.log(`     cases ${review.cases}  passed ${review.passed}  failed ${review.failed}`);
console.log(`5. FINAL STATE ${line('FINAL STATE')} (statuses, kinds and planned windows)`);
for (const l of pairs.filter((x) => x.includes('FAIL'))) console.log(l);
await prisma.$disconnect();
