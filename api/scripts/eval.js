import { readFileSync } from 'node:fs';
import { prisma } from '../src/db/prisma.js';

const goldenFile = process.argv.find((a) => a.startsWith('--file='))?.split('=')[1] ?? 'links.json';
const golden = JSON.parse(readFileSync(new URL(`../tests/golden/${goldenFile}`, import.meta.url), 'utf8'));
delete golden._note;
delete golden._kind; // "holdout" (labelled blind, never used to tune) or "tuning" / "regression" (may be looked at)
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const from = arg('from') ? new Date(arg('from')) : null;
const to = arg('to') ? new Date(arg('to')) : null;

const posts = await prisma.sourcePost.findMany({
  where: { OR: Object.keys(golden).map((s) => ({ externalId: { endsWith: s } })) },
  select: { externalId: true, publishedAt: true, outagePosts: { select: { outageId: true } }, text: true },
});

const items = [];
for (const p of posts) {
  if ((from && p.publishedAt < from) || (to && p.publishedAt >= to)) continue;
  const key = Object.keys(golden).find((k) => p.externalId.endsWith(k));
  items.push({ key, truth: golden[key], predicted: new Set(p.outagePosts.map((o) => o.outageId)), text: p.text.replace(/\s+/g, ' ').slice(0, 80) });
}
const missing = Object.keys(golden).filter((k) => !items.some((i) => i.key === k));

// Non-outage posts: correct only when not attached to any outage.
const none = items.filter((i) => i.truth === 'NONE');
const wrongNone = none.filter((i) => i.predicted.size > 0);
const labelled = items.filter((i) => i.truth !== 'NONE');

let tp = 0, fp = 0, fn = 0;
const splitPairs = [];
const mergedPairs = [];
for (let a = 0; a < labelled.length; a++) {
  for (let b = a + 1; b < labelled.length; b++) {
    const A = labelled[a], B = labelled[b];
    const sameTruth = A.truth === B.truth;
    const samePred = [...A.predicted].some((o) => B.predicted.has(o));
    if (sameTruth && samePred) tp++;
    else if (!sameTruth && samePred) { fp++; mergedPairs.push([A, B]); }
    else if (sameTruth && !samePred) { fn++; splitPairs.push([A, B]); }
  }
}
const precision = tp / (tp + fp || 1);
const recall = tp / (tp + fn || 1);
const f1 = (2 * precision * recall) / (precision + recall || 1);

console.log(`posts labelled: ${labelled.length} (+${none.length} non-outage), missing in DB: ${missing.join(',') || 'none'}`);
console.log(`pairwise precision ${(precision * 100).toFixed(1)}%  recall ${(recall * 100).toFixed(1)}%  F1 ${(f1 * 100).toFixed(1)}%`);
console.log(`non-outage posts wrongly attached to an outage: ${wrongNone.length}/${none.length}`);

const groups = (pairs) => {
  const m = new Map();
  for (const [a, b] of pairs) {
    const k = `${a.truth} ~ ${b.truth}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15);
};
console.log('\nWRONGLY MERGED (truth groups sharing an outage):');
for (const [k, n] of groups(mergedPairs)) console.log(`  ${n}× ${k}`);
console.log('\nWRONGLY SPLIT (same truth, different outages):');
for (const [k, n] of groups(splitPairs)) console.log(`  ${n}× ${k}`);
if (wrongNone.length) console.log('\nNON-OUTAGE attached:', wrongNone.map((i) => `${i.key} "${i.text}"`));
await prisma.$disconnect();

// Optional quality gate for CI / release checks:  --min-f1=90  --min-precision=90  --min-recall=90  (percent), also fails on non-outage posts attached to outages.
// Without these flags the exit code stays 0 as before: a person reads the numbers.
const gate = [];
for (const [flag, value] of [['min-f1', f1], ['min-precision', precision], ['min-recall', recall]]) {
  const min = arg(flag);
  if (min !== undefined && value * 100 < Number(min)) gate.push(`${flag.slice(4)} ${(value * 100).toFixed(1)}% is below ${min}%`);
}
if (process.argv.includes('--strict-none') && wrongNone.length) gate.push(`${wrongNone.length} non-outage posts attached to outages`);
if (missing.length && process.argv.includes('--strict-missing')) gate.push(`${missing.length} labelled posts are missing from the database`);
if (gate.length) {
  console.error(`
QUALITY GATE FAILED: ${gate.join('; ')}`);
  process.exitCode = 1;
}
