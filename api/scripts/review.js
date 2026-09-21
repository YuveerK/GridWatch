// The queue of suspicious changes (it points at things to look at; it never changes an outage).
//   npm run review                          the open items, most urgent first
//   npm run review -- --all                 also resolved and dismissed ones
//   npm run review -- --resolve <id> [--dismiss] [--note "why"]
//   npm run review -- --verify <id>         ask the independent verifier about one item now (needs VERIFIER_ENABLED=on, or --force)
import { prisma } from '../src/db/prisma.js';
import { listReviewItems, resolveReviewItem } from '../src/modules/review/review.service.js';
import { verifyItem } from '../src/modules/review/verifier.js';

const args = process.argv.slice(2);
const val = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null);
const short = (d) => new Date(d).toISOString().slice(5, 16).replace('T', ' ');

if (val('resolve')) {
  const r = await resolveReviewItem({ prisma, id: val('resolve'), status: args.includes('--dismiss') ? 'DISMISSED' : 'RESOLVED', resolution: val('note') });
  console.log(`${r.status}: ${r.id}`);
} else if (val('verify')) {
  const item = await prisma.reviewItem.findUniqueOrThrow({ where: { id: val('verify') } });
  const v = await verifyItem({ prisma, item, force: args.includes('--force') });
  console.log(v ? `${v.verdict}: ${v.reason}${v.quote ? `\n  quote: "${v.quote}"` : ''}` : 'The verifier is off (set VERIFIER_ENABLED=on, or pass --force) or today\'s call cap is used.');
} else {
  for (const status of args.includes('--all') ? ['OPEN', 'RESOLVED', 'DISMISSED'] : ['OPEN']) {
    const items = await listReviewItems({ prisma, status, limit: 100 });
    console.log(`${status}: ${items.length}`);
    for (const i of items) {
      console.log(`\n  [${i.priority}] ${i.id}  ${short(i.publishedAt)}  ${i.externalId.slice(-8)}${i.faultIndex ? ` fault ${i.faultIndex}` : ''}${i.sampled ? '  (spot check)' : ''}`);
      console.log(`      ${i.reasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}`);
      console.log(`      "${i.text}"`);
      if (i.verifier) console.log(`      verifier: ${i.verifier.verdict}${i.verifier.reason ? ` - ${i.verifier.reason}` : ''}${i.verifier.quote ? ` | "${i.verifier.quote}"` : ''}`);
    }
  }
}
await prisma.$disconnect();
