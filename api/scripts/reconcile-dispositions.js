// Repair only posts whose current fault layout and stored decisions disagree.
// Preview: node scripts/reconcile-dispositions.js
// Apply:   node scripts/reconcile-dispositions.js --apply [--include-overrides] [--post=<externalId>]
// Uses stored readings, the pipeline lease, and the standard reversible repair snapshot.
process.env.GRIDWATCH_AI_ONLY ??= 'tiebreak';
process.env.GRIDWATCH_AI_MAX_CALLS ??= '100';
const { prisma } = await import('../src/db/prisma.js');
const { acceptedExtraction, checkPostDispositions, readingFaultItems } = await import('../src/modules/processing/quality.js');
const { faultItems, reprocessPost } = await import('../src/modules/processing/processor.service.js');
const { snapshotForPosts, restoreSnapshot } = await import('../src/modules/processing/repair.js');
const { reconcileReviewItems } = await import('../src/modules/review/review.service.js');
const { saveSnapshotFile } = await import('../src/modules/processing/repair-files.js');
const { PIPELINE, withLease } = await import('../src/modules/coordination/lease.js');
const { sweepStaleOutages } = await import('../src/modules/outages/linker.service.js');
const apply = process.argv.includes('--apply');
const includeOverrides = process.argv.includes('--include-overrides');
const externalId = process.argv.find((a) => a.startsWith('--post='))?.slice(7);

async function plan() {
  const posts = await prisma.sourcePost.findMany({
    where: externalId ? { externalId } : {},
    orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
    include: { extractions: true, linkDecisions: true, outagePosts: true },
  });
  const overrides = await prisma.linkOverride.findMany();
  const rows = [];
  for (const post of posts) {
    if (/^\s*@\w+/.test(post.noteTweetText || post.text || '')) continue;
    const extraction = acceptedExtraction(post);
    if (!extraction?.result) continue;
    const items = readingFaultItems(post, extraction, faultItems);
    const verdict = checkPostDispositions({ expectedIndices: items.map((i) => i.faultIndex), decisions: post.linkDecisions, outagePosts: post.outagePosts });
    if (!verdict.problems.length) continue;
    const manual = overrides.filter((o) => o.postId === post.id || o.anchorPostId === post.id);
    rows.push({ post, items, manual, problems: verdict.problems });
  }
  return rows;
}

async function run(ctx) {
  const rows = await plan();
  for (const { post, manual, problems } of rows) console.log(`${post.serviceType} ${post.sourceAccount} ${post.externalId} ${post.id}${manual.length ? ` [${manual.length} override references]` : ''}: ${problems.join('; ')}`);
  const selected = rows.filter((r) => includeOverrides || !r.manual.length);
  console.log(`${rows.length} inconsistent posts; ${selected.length} selected; ${rows.length - selected.length} held for override inspection.`);
  if (!apply || !selected.length) return;
  ctx.assertHeld();
  const snapshot = await snapshotForPosts(prisma, selected.map((r) => r.post.id));
  const file = saveSnapshotFile(snapshot, 'dispositions');
  console.log(`Snapshot: ${file}`);
  console.log(`Undo: node scripts/restore-repair.js "${file}" --apply`);
  try {
    for (const { post } of selected) {
      const result = await reprocessPost(post.id, { ctx });
      console.log(`${post.externalId}: ${result.outcome}`);
      if (['BUSY', 'ERROR', 'NEEDS_REVIEW', 'FAILED'].includes(result.outcome)) {
        throw new Error(`Repair stopped at ${post.externalId}: ${result.error ?? result.outcome}`);
      }
    }
  } catch (error) {
    ctx.assertHeld();
    console.error('Restoring this batch after failure:', error.message);
    await restoreSnapshot({ prisma, snapshot, ctx });
    await reconcileReviewItems({ prisma, postIds: snapshot.postIds });
    await sweepStaleOutages(new Date(), { ctx });
    throw error;
  }
  console.log('Production quiet sweep:', await sweepStaleOutages(new Date(), { ctx }));
  const remaining = await plan();
  console.log(`Remaining inconsistent posts: ${remaining.length}`);
  if (remaining.length) process.exitCode = 1;
}

try {
  if (apply) {
    const result = await withLease(PIPELINE, run);
    if (!result.acquired) { console.error('Pipeline lease is held; nothing changed.'); process.exitCode = 1; }
  } else await run(null);
} finally {
  await prisma.$disconnect();
}
