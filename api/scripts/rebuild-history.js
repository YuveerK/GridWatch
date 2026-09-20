// Rebuild every outage, link and learned equipment from the stored readings with the CURRENT rules, oldest post first.
// This is the safe wrapper around `relink`: it backs up what it is about to delete, keeps the map positions of learned
// suburbs, allows paid AI ONLY for the small tie-break question (capped), and prints a before/after check.
//   node scripts/rebuild-history.js             report only
//   node scripts/rebuild-history.js --confirm   do it
// Post readings are never re-bought: they are reused from the database.
process.env.GRIDWATCH_AI_ONLY ??= 'tiebreak';
process.env.GRIDWATCH_AI_MAX_CALLS ??= '60';
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { prisma } = await import('../src/db/prisma.js');
const { processPending, resetLearnedState } = await import('../src/modules/processing/processor.service.js');
const { aiUsage } = await import('../src/modules/ai/gemini.client.js');

const confirm = process.argv.includes('--confirm');
const count = async () => ({
  outages: await prisma.outage.count(),
  timeline: await prisma.outagePost.count(),
  decisions: await prisma.linkDecision.count(),
  equipment: await prisma.infraNode.count(),
  learnedSuburbs: await prisma.locality.count({ where: { sourceLabel: 'learned-from-posts' } }),
  outagesWithFullHistory: await prisma.outagePost.count({ where: { effect: { not: null } } }),
});
const before = await count();
console.log(confirm ? 'Rebuilding. Before:' : 'Dry run. This would delete and rebuild:', before);
if (!confirm) {
  console.log('Re-run with --confirm. A JSON backup is written first to data/backups/.');
  await prisma.$disconnect();
  process.exit(0);
}

// 1. backup
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `pre-rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const backup = {
  outages: await prisma.outage.findMany(),
  outagePosts: await prisma.outagePost.findMany(),
  outageNodes: await prisma.outageNode.findMany(),
  outageLocalities: await prisma.outageLocality.findMany(),
  linkDecisions: await prisma.linkDecision.findMany(),
  infraNodes: await prisma.infraNode.findMany(),
  infraEdges: await prisma.infraEdge.findMany(),
  nodeLocalities: await prisma.nodeLocality.findMany(),
  nodeAliases: await prisma.nodeAlias.findMany(),
  evidence: await prisma.evidenceContribution.findMany(),
  learnedSuburbs: await prisma.locality.findMany({ where: { sourceLabel: 'learned-from-posts' } }),
};
fs.writeFileSync(file, JSON.stringify(backup));
console.log(`Backup written: ${file}`);

// 2. remember where learned suburbs were placed on the map
const positions = new Map(backup.learnedSuburbs.filter((l) => l.lat != null).map((l) => [l.normalizedName, { lat: l.lat, lon: l.lon, geoSource: l.geoSource }]));

// 3. rebuild (the scheduler may hold the pipeline lease for a moment during a fetch)
for (let i = 0; ; i++) {
  try {
    await resetLearnedState();
    break;
  } catch (err) {
    if (i >= 8 || !/lease/.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
console.log('Cleared. Rebuilding from stored readings...');
let result;
for (let i = 0; i < 8; i++) {
  result = await processPending();
  if (!result.skipped) break;
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log('Processed:', result);

// 4. put the map positions back
let restored = 0;
for (const [normalizedName, pos] of positions) {
  const res = await prisma.locality.updateMany({ where: { normalizedName, regionId: null, lat: null }, data: { lat: pos.lat, lon: pos.lon, geoSource: pos.geoSource } });
  restored += res.count;
}
console.log(`Map positions restored for ${restored} learned suburbs.`);
// a rebuild recreates every outage as live: the housekeeping sweep marks the old ones stale/closed, as it does every hour
const { sweepStaleOutages } = await import('../src/modules/outages/linker.service.js');
console.log('Sweep:', await sweepStaleOutages());
console.log('AI calls (tie-breaks only):', aiUsage);
console.log('After:', await count());
await prisma.$disconnect();
