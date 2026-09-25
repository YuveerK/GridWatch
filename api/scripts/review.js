// The queue of suspicious changes (it points at things to look at; it never changes an outage).
//   npm run review
//   npm run review -- --all
//   npm run review -- --service=ELECTRICITY
//   npm run review -- --service=WATER
//   npm run review -- --source=CityPowerJhb
//   npm run review -- --resolved
//   npm run review -- --resolve <id> [--dismiss] [--note "why"]
//   npm run review -- --inspect <reviewId>
//   npm run review -- --verify <id>
import { prisma } from '../src/db/prisma.js';
import { listReviewItems, loadReviewInspection, resolveReviewItem } from '../src/modules/review/review.service.js';
import { verifyItem } from '../src/modules/review/verifier.js';

const args = process.argv.slice(2);
const exact = (name) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`) || args.some((a) => a.startsWith(`--${name}=`));
const short = (d) => new Date(d).toISOString().slice(5, 16).replace('T', ' ');

if (exact('inspect') && !exact('inspect').startsWith('--')) {
  const text = await loadReviewInspection({ prisma, id: exact('inspect') });
  console.log(text ?? `No review item ${exact('inspect')}`);
} else if (exact('resolve') && !exact('resolve').startsWith('--')) {
  const r = await resolveReviewItem({ prisma, id: exact('resolve'), status: has('dismiss') ? 'DISMISSED' : 'RESOLVED', resolution: exact('note') });
  console.log(`${r.status}: ${r.id}`);
} else if (exact('verify') && !exact('verify').startsWith('--')) {
  const item = await prisma.reviewItem.findUniqueOrThrow({ where: { id: exact('verify') } });
  const v = await verifyItem({ prisma, item, force: has('force') });
  console.log(v ? `${v.verdict}: ${v.reason}${v.quote ? `\n  quote: "${v.quote}"` : ''}` : 'The verifier is off (set VERIFIER_ENABLED=on, or pass --force) or today\'s call cap is used.');
} else {
  const service = exact('service');
  const source = exact('source');
  const statuses = has('resolved') ? ['RESOLVED'] : has('all') ? ['OPEN', 'RESOLVED', 'DISMISSED'] : ['OPEN'];
  for (const status of statuses) {
    const items = await listReviewItems({ prisma, status, service, source, limit: 500 });
    const shown = has('all') || status !== 'OPEN' ? items : items.filter((i) => !i.sampled);
    const hidden = items.length - shown.length;
    if (status === 'OPEN' && !has('resolved')) {
      const byService = new Map();
      for (const item of shown) {
        const accounts = byService.get(item.serviceType) ?? new Map();
        accounts.set(item.sourceAccount, (accounts.get(item.sourceAccount) ?? 0) + 1);
        byService.set(item.serviceType, accounts);
      }
      console.log(`ACTIONABLE OPEN: ${shown.length}\n`);
      for (const svc of ['ELECTRICITY', 'WATER']) {
        console.log(svc);
        const accounts = byService.get(svc);
        if (!accounts?.size) console.log('  (none)');
        else for (const [account, n] of accounts) console.log(`  ${account.padEnd(16)} ${n}`);
        console.log('');
      }
      if (hidden) console.log(`Historical/non-actionable items hidden: ${hidden}\nUse --all to inspect.\n`);
    } else {
      console.log(`${status}: ${shown.length}`);
    }
    for (const i of shown) {
      console.log(`  [${i.priority}] ${i.serviceType} ${i.sourceAccount}  ${short(i.publishedAt)}  ${i.externalId.slice(-8)}${i.faultIndex ? ` fault ${i.faultIndex}` : ''}${i.sampled ? '  (spot check)' : ''}`);
      console.log(`      ${i.reasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}`);
      console.log(`      "${i.text}"`);
    }
  }
}
await prisma.$disconnect();
