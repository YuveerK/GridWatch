import { readFileSync } from 'node:fs';
import { prisma } from '../src/db/prisma.js';

const golden = JSON.parse(readFileSync(new URL('../tests/golden/links.json', import.meta.url), 'utf8'));
delete golden._note;

const posts = await prisma.sourcePost.findMany({
  where: { OR: Object.keys(golden).map((s) => ({ externalId: { endsWith: s } })) },
  select: { externalId: true, outagePost: { select: { outageId: true } }, text: true },
});

const items = [];
for (const p of posts) {
  const key = Object.keys(golden).find((k) => p.externalId.endsWith(k));
  items.push({ key, truth: golden[key], predicted: p.outagePost?.outageId ?? null, text: p.text.replace(/\s+/g, ' ').slice(0, 80) });
}
const missing = Object.keys(golden).filter((k) => !items.some((i) => i.key === k));

// Non-outage posts: correct only when not attached to any outage.
const none = items.filter((i) => i.truth === 'NONE');
const wrongNone = none.filter((i) => i.predicted);
const labelled = items.filter((i) => i.truth !== 'NONE');

let tp = 0, fp = 0, fn = 0;
const splitPairs = [];
const mergedPairs = [];
for (let a = 0; a < labelled.length; a++) {
  for (let b = a + 1; b < labelled.length; b++) {
    const A = labelled[a], B = labelled[b];
    const sameTruth = A.truth === B.truth;
    const samePred = A.predicted && A.predicted === B.predicted;
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
