// Bounded historical fetch for one source account. Does not call Gemini and does not activate the account.
// The live high-water mark moves only after every page of the window has been stored.
//
//   node scripts/backfill-source-account.js --handle JHBWater --service WATER --from 2026-09-01T00:00:00+02:00 --to now --fetch-only
//   node scripts/backfill-source-account.js --handle JHBWater --service WATER --from 2026-09-01T00:00:00+02:00 --max 5000
import { prisma } from '../src/db/prisma.js';
import { backfillAccount } from '../src/modules/ingestion/ingestion.service.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const handle = flag('handle');
const service = flag('service')?.toUpperCase() ?? null;
const from = flag('from');
const toRaw = flag('to');
const max = flag('max') != null ? Number(flag('max')) : 2000;
if (!handle || !from) {
  console.error('Usage: node scripts/backfill-source-account.js --handle <name> --from <ISO> [--to now|<ISO>] [--service WATER] [--max 2000] --fetch-only');
  process.exit(1);
}
const account = await prisma.sourceAccount.findFirst({ where: { displayName: handle } });
if (!account) {
  console.error(`No source account named ${handle}. Seed it first and leave it inactive.`);
  process.exit(1);
}
if (service && account.serviceType !== service) {
  console.error(`${handle} is ${account.serviceType}, not ${service}.`);
  process.exit(1);
}
// Keep an open upper bound stable across resumed runs; the service saves the first run's bound.
const to = !toRaw || toRaw === 'now' ? null : new Date(toRaw);
const result = await backfillAccount({ handle, from, to, maxPosts: max });
if (result.skipped) {
  console.error('Another worker holds the pipeline lease.');
  process.exit(1);
}

const posts = await prisma.sourcePost.findMany({
  where: { sourceAccount: handle, publishedAt: { gte: new Date(from), lt: result.to } },
  select: { externalId: true, publishedAt: true, processingStatus: true, PostMedia: { select: { id: true } } },
  orderBy: { publishedAt: 'asc' },
});
const withImages = posts.filter((p) => p.PostMedia.length).length;
const byStatus = {};
for (const p of posts) byStatus[p.processingStatus] = (byStatus[p.processingStatus] ?? 0) + 1;
const fmt = (d) => new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
console.log(`\n${account.displayName} historical fetch (${account.serviceType})`);
console.log(`Requested:\n${fmt(from)} → ${fmt(result.to)}\n`);
console.log(`Posts fetched:        ${result.postsFetched}`);
console.log(`Posts newly inserted: ${result.postsInserted}`);
console.log(`Already present:      ${result.postsDeduplicated}`);
console.log(`\nPosts with images:    ${withImages}`);
console.log(`Text-only posts:      ${posts.length - withImages}`);
console.log(`\nEarliest post: ${posts[0] ? `${fmt(posts[0].publishedAt)}  ${posts[0].externalId}` : '-'}`);
console.log(`Latest post:   ${posts.at(-1) ? `${fmt(posts.at(-1).publishedAt)}  ${posts.at(-1).externalId}` : '-'}`);
console.log('\nProcessing:');
for (const [status, n] of Object.entries(byStatus)) console.log(`${status}: ${n}`);
if (result.ceiling) {
  console.log(`\nStopped after the page containing the ${max}-post safety ceiling. What was fetched is kept. Rerun the same command to continue, or pass --max to raise the ceiling.`);
}
if (result.error) console.log(`\nStopped: ${result.status} ${result.error}`);
console.log(result.complete ? '\nWindow complete. The live high-water changes only for a new account with no live checkpoint.' : '\nWindow not finished. Live high-water was not moved.');
await prisma.$disconnect();
process.exit(result.error ? 1 : 0);
