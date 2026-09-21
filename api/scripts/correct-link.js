// Correct where one post belongs. The correction is stored, so every later re-link or rebuild applies it again.
//   node scripts/correct-link.js <post> --split --from <post> [--note "why"]  make it its own new outage (--from: the post it was wrongly joined with)
//   node scripts/correct-link.js <post> --join <anchorPost> [--note ".."]  put it in the outage the anchor post is in
//   node scripts/correct-link.js <post> --clear                            drop the correction (normal rules decide again)
//   node scripts/correct-link.js --list                                    show every stored correction
// <post> is a database id or the X post id. Add --fault N for a graphic with several faults. Without --apply it only reports.
// The post is then re-linked from its stored reading (no AI, no X).
process.env.GRIDWATCH_NO_AI ??= '1'; // callers may set it to empty and allow the tie-break (GRIDWATCH_AI_ONLY=tiebreak GRIDWATCH_AI_MAX_CALLS=n) when the post has other faults to re-judge
const { prisma } = await import('../src/db/prisma.js');
const { setOverride, clearOverride } = await import('../src/modules/outages/overrides.js');
const { reprocessPost } = await import('../src/modules/processing/processor.service.js');

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const valueFlags = new Set(['--join', '--note', '--fault', '--from']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
const apply = args.includes('--apply');
const find = (ref) => prisma.sourcePost.findFirst({ where: { OR: [{ id: ref }, { externalId: ref }] }, select: { id: true, externalId: true, publishedAt: true, text: true, noteTweetText: true } });
const where = async (postId) => {
  const links = await prisma.outagePost.findMany({ where: { postId }, select: { outage: { select: { id: true, title: true, status: true, startedAt: true, _count: { select: { posts: true } } } } } });
  return links.map((l) => `${l.outage.title} [${l.outage.status}] started ${l.outage.startedAt.toISOString().slice(0, 16)}, ${l.outage._count.posts} posts (${l.outage.id})`);
};
const fail = (m) => {
  console.error(m);
  process.exit(1);
};

if (args.includes('--list')) {
  const rows = await prisma.linkOverride.findMany({ include: { post: { select: { externalId: true } }, anchor: { select: { externalId: true } } }, orderBy: { createdAt: 'asc' } });
  if (!rows.length) console.log('No corrections stored.');
  for (const r of rows) console.log(`${r.post.externalId} fault ${r.faultIndex}: ${r.action}${r.anchor ? ` with ${r.anchor.externalId}` : ''}${r.note ? ` - ${r.note}` : ''}`);
  await prisma.$disconnect();
  process.exit(0);
}

const ref = positional[0];
if (!ref) fail('Give the post (database id or X post id). See the top of this file for usage.');
const post = await find(ref);
if (!post) fail(`Post not found: ${ref}`);
const faultIndex = Number(flag('--fault') ?? 0);
const mode = args.includes('--split') ? 'SPLIT' : flag('--join') ? 'JOIN' : args.includes('--clear') ? 'CLEAR' : null;
if (!mode) fail('Say what to do: --split, --join <anchorPost> or --clear.');
let contrast = null;
if (mode === 'SPLIT' && flag('--from')) {
  contrast = await find(flag('--from'));
  if (!contrast) fail(`The post to keep it apart from was not found: ${flag('--from')}`);
}
let anchor = null;
if (mode === 'JOIN') {
  anchor = await find(flag('--join'));
  if (!anchor) fail(`Anchor post not found: ${flag('--join')}`);
  if (!(await prisma.outagePost.count({ where: { postId: anchor.id } }))) fail('The anchor post is not part of any outage yet.');
}

console.log(`${post.externalId}  ${post.publishedAt.toISOString().slice(0, 16)}Z\n  "${(post.noteTweetText || post.text).replace(/\s+/g, ' ').slice(0, 160)}"`);
console.log('Now in:', (await where(post.id)).join('\n        ') || 'no outage');
console.log(mode === 'SPLIT' ? 'Will become: its own new outage' : mode === 'JOIN' ? `Will join: ${(await where(anchor.id)).join(' | ')}` : 'Will: go back to the normal rules');
if (!apply) {
  console.log('\nReport only. Add --apply to do it.');
  await prisma.$disconnect();
  process.exit(0);
}

if (mode === 'CLEAR') await clearOverride(post.id, faultIndex);
else await setOverride({ postId: post.id, faultIndex, action: mode, anchorPostId: anchor?.id ?? null, note: flag('--note'), contrastPostId: contrast?.id ?? null });
const res = await reprocessPost(post.id);
if (res.outcome === 'BUSY') fail('The pipeline is busy (a fetch is running). The correction is stored; re-run the same command in a minute to apply it.');
console.log('Re-linked:', res);
console.log('Now in:', (await where(post.id)).join('\n        ') || 'no outage');
// every correction is evidence of what the engine should have done: it becomes a permanent test case
if (mode !== 'CLEAR') {
  const { exportCorrections } = await import('./export-corrections.js');
  const r = await exportCorrections({ write: true });
  console.log(r.added.length ? `Added ${r.added.length} test case(s) to tests/golden/corrections.json (commit that file).` : mode === 'SPLIT' && !contrast ? 'Not turned into a test: a split needs --from <the post it was wrongly joined with>.' : 'Already a test case.');
}
await prisma.$disconnect();
