// Merge two equipment names that are the same station misspelt ("Karzene" / "Kazerne"). The dropped name becomes an alias of the kept one,
// the dropped node is deleted, and every post that had been linked through it is re-linked (oldest first) so outages, counters and the
// graph come out exactly as if the name had always been read as the kept one. Stored readings are reused; no post is re-read.
//   node scripts/merge-nodes.js --keep karzene --drop kazerne            report only
//   node scripts/merge-nodes.js --keep karzene --drop kazerne --apply    do it
//   --municipality JOHANNESBURG   when the same name exists in two municipalities (Orchards in Johannesburg and in Tshwane)
// The re-linking may ask the AI small "same fault or not?" questions (tie-breaks only). Cap them with GRIDWATCH_AI_MAX_CALLS (default 10 here).
process.env.GRIDWATCH_AI_ONLY ??= 'tiebreak';
process.env.GRIDWATCH_AI_MAX_CALLS ??= '10';
const { prisma } = await import('../src/db/prisma.js');
const { reprocessPost } = await import('../src/modules/processing/processor.service.js');
const { aiUsage } = await import('../src/modules/ai/gemini.client.js');

const args = process.argv.slice(2);
const arg = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null);
const apply = args.includes('--apply');
const keepKey = arg('keep');
const dropKey = arg('drop');
if (!keepKey || !dropKey || keepKey === dropKey) {
  console.error('Give --keep <normalized name> and --drop <normalized name>, for example --keep karzene --drop kazerne');
  process.exit(1);
}
const STATIONS = ['SUBSTATION', 'SWITCHING_STATION'];
const muniCode = arg('municipality');
const muni = muniCode ? await prisma.municipality.findUnique({ where: { code: muniCode.toUpperCase() } }) : null;
if (muniCode && !muni) throw new Error(`no municipality with code ${muniCode}`);
const find = async (key) => {
  const nodes = await prisma.infraNode.findMany({ where: { normalizedKey: key, type: { in: STATIONS }, ...(muni ? { municipalityId: muni.id } : {}) } });
  if (nodes.length !== 1) throw new Error(`expected exactly one station named "${key}"${muni ? ` in ${muni.code}` : ''}, found ${nodes.length}${muni ? '' : ' (add --municipality CODE when the name exists in several)'}`);
  return nodes[0];
};
const keep = await find(keepKey);
const drop = await find(dropKey);

// every post that touched the dropped node: through what it taught the graph, or through an outage effect that names it
const viaEvidence = await prisma.evidenceContribution.findMany({ where: { OR: [{ refA: drop.id }, { refB: drop.id }] }, select: { postId: true } });
const viaEffects = await prisma.$queryRaw`SELECT DISTINCT "postId" FROM "OutagePost" WHERE "effect"::text LIKE ${`%${drop.id}%`}`;
const ids = [...new Set([...viaEvidence.map((r) => r.postId), ...viaEffects.map((r) => r.postId)])];
const posts = await prisma.sourcePost.findMany({ where: { id: { in: ids } }, orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }], select: { id: true, externalId: true, publishedAt: true } });
const primary = await prisma.outage.count({ where: { primaryNodeId: drop.id } });

console.log(`keep: ${keep.name} (${keep.type}, evidence ${keep.evidenceCount})\ndrop: ${drop.name} (${drop.type}, evidence ${drop.evidenceCount}) -> becomes an alias of "${keep.name}"`);
console.log(`${posts.length} post(s) will be re-linked, oldest first:`);
for (const p of posts) console.log(`  ${p.publishedAt.toISOString().slice(0, 16)}Z  ${p.externalId}`);
if (primary) console.log(`${primary} outage(s) list it as their main equipment (re-linking sets that again).`);
if (!apply) {
  console.log('\nReport only. Add --apply to do it.');
  await prisma.$disconnect();
  process.exit(0);
}

// staged and reversible: everything these posts and this node touch is saved first (undo: node scripts/restore-repair.js <file> --apply)
const { snapshotForPosts } = await import('../src/modules/processing/repair.js');
const { saveSnapshotFile } = await import('../src/modules/processing/repair-files.js');
const snapshotFile = saveSnapshotFile(await snapshotForPosts(prisma, posts.map((p) => p.id)), 'merge-nodes', { removeAlias: { nodeId: keep.id, normalizedKey: drop.normalizedKey } });
console.log(`Snapshot saved: ${snapshotFile}`);
await prisma.nodeAlias.upsert({ where: { nodeId_normalizedKey: { nodeId: keep.id, normalizedKey: drop.normalizedKey } }, create: { nodeId: keep.id, alias: drop.name, normalizedKey: drop.normalizedKey }, update: {} });
await prisma.outage.updateMany({ where: { primaryNodeId: drop.id }, data: { primaryNodeId: keep.id } });
await prisma.infraNode.delete({ where: { id: drop.id } }); // cascades its outage links, edges, locality links and aliases; the posts below are then learned again
console.log('Dropped node deleted; alias added. Re-linking...');
for (const p of posts) {
  const r = await reprocessPost(p.id);
  console.log(`  ${p.externalId}: ${r.outcome ?? 'done'}`);
  if (r.outcome === 'BUSY') throw new Error('the pipeline is busy; stopped part-way. Run the same command again once it is free (the alias is already in place).');
}
console.log('AI calls (tie-breaks only):', aiUsage);
await prisma.$disconnect();
