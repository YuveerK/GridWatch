// Bring existing data in line with the newer rules, using STORED readings only (no AI, no X).
//   node scripts/relink-affected.js            report only
//   node scripts/relink-affected.js --apply    do it
// Three things: (1) posts naming places in a "restored to X" sentence are re-linked, oldest first; (2) planned outages whose
// announced window would now read differently get the new window written directly (nothing needs re-linking for that);
// (3) suburbs that are a one-letter typo of a known suburb are merged into it. AI is switched off for the run: a tie-break that is not already
// cached becomes "needs review" instead of a paid call, and the report says so.
process.env.GRIDWATCH_NO_AI = '1';
const { prisma } = await import('../src/db/prisma.js');
const { markRestoredPlaces } = await import('../src/lib/restored-places.js');
const { scheduleWindow } = await import('../src/lib/schedule.js');
const { oneEditApart } = await import('../src/lib/normalize.js');
const { faultItems, reprocessPost } = await import('../src/modules/processing/processor.service.js');

const apply = process.argv.includes('--apply');
const why = new Map(); // postId -> [reasons]
const windows = []; // planned outages whose announced window changes: { id, title, start, end }
const add = (id, reason) => why.set(id, [...(why.get(id) ?? []), reason]);

// 1. "restored to X" places
const posts = await prisma.sourcePost.findMany({ where: { linkDecisions: { some: {} } }, select: { id: true, text: true, noteTweetText: true, publishedAt: true, extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 } } });
for (const p of posts) {
  const ex = p.extractions[0];
  if (!ex?.result) continue;
  const text = p.noteTweetText || p.text;
  const extraction = { ...ex, result: ex.result };
  if (markRestoredPlaces(extraction.result, text) !== extraction.result) add(p.id, 'a place is named in a "restored to" sentence');
}

// 2. planned windows that differ from what the current rule reads
const planned = await prisma.outage.findMany({ where: { kind: 'PLANNED' }, select: { id: true, title: true, scheduledStart: true, scheduledEnd: true, posts: { orderBy: { postedAt: 'desc' }, take: 1, select: { postId: true, post: { select: { text: true, noteTweetText: true, publishedAt: true, extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 } } } } } } });
for (const o of planned) {
  const last = o.posts[0];
  const ex = last?.post.extractions[0];
  if (!last || !ex?.result) continue;
  const item = faultItems({ ...ex, result: ex.result })[0];
  const w = scheduleWindow(item.extraction, item.fromDigest ? '' : last.post.noteTweetText || last.post.text, last.post.publishedAt);
  if (w && (!o.scheduledStart || +new Date(w.start) !== +o.scheduledStart || +new Date(w.end) !== +o.scheduledEnd)) windows.push({ id: o.id, title: o.title, start: new Date(w.start), end: new Date(w.end) });
}

// 3. learned suburbs that are a one-letter typo of a real one (merged, not relinked)
const all = await prisma.locality.findMany({ select: { id: true, canonicalName: true, normalizedName: true, sourceLabel: true, regionId: true } });
const real = all.filter((l) => l.regionId);
const typos = [];
for (const l of all.filter((x) => !x.regionId && x.sourceLabel === 'learned-from-posts' && x.normalizedName.length >= 6 && !/\d/.test(x.normalizedName))) {
  const near = real.filter((r) => r.normalizedName[0] === l.normalizedName[0] && oneEditApart(l.normalizedName, r.normalizedName));
  if (near.length === 1) typos.push({ from: l, into: near[0] });
}

// A finished outage (restored or closed) already shows every suburb as back on, so re-linking its posts could only add risk:
// only posts whose outage is still open are worth re-linking.
const candidates = await prisma.sourcePost.findMany({ where: { id: { in: [...why.keys()] } }, orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }], select: { id: true, externalId: true, publishedAt: true, outagePosts: { select: { outage: { select: { status: true } } } } } });
const finished = new Set(['RESTORED', 'CLOSED', 'CANCELLED']);
const skipped = candidates.filter((p) => p.outagePosts.length && p.outagePosts.every((o) => finished.has(o.outage.status)));
const ordered = candidates.filter((p) => !skipped.includes(p));
if (skipped.length) console.log(`${skipped.length} post(s) skipped: their outage is already finished, so nothing on screen would change (${skipped.map((p) => p.externalId.slice(-6)).join(', ')}).\n`);
console.log(`${ordered.length} post(s) to relink:`);
for (const p of ordered) console.log(`  ${p.publishedAt.toISOString().slice(0, 16)}  ${p.externalId}  ${why.get(p.id).join('; ')}`);
console.log(`\n${windows.length} planned window(s) to update:`);
for (const w of windows) console.log(`  ${w.title.slice(0, 50)}: ${w.start.toISOString().slice(0, 16)} to ${w.end.toISOString().slice(0, 16)}`);
console.log(`\n${typos.length} typo suburb(s) to merge:`);
for (const t of typos) console.log(`  "${t.from.canonicalName}" -> "${t.into.canonicalName}"`);

if (!apply) {
  console.log('\nNothing changed. Re-run with --apply.');
  await prisma.$disconnect();
  process.exit(0);
}

for (const w of windows) await prisma.outage.update({ where: { id: w.id }, data: { scheduledStart: w.start, scheduledEnd: w.end } });
console.log(`Updated ${windows.length} planned window(s).`);
let review = 0;
for (const p of ordered) {
  let res = await reprocessPost(p.id);
  for (let i = 0; res.outcome === 'BUSY' && i < 6; i++) {
    await new Promise((r) => setTimeout(r, 15_000)); // the scheduler holds the lease for a moment during a fetch
    res = await reprocessPost(p.id);
  }
  if (res.outcome === 'NEEDS_REVIEW' || res.outcome === 'BUSY' || res.outcome === 'ERROR') review++;
  console.log(`  ${p.externalId}: ${res.outcome}`);
}
console.log(`\nRelinked ${ordered.length} post(s); ${review} did not link cleanly (needs review or busy) and are listed above.`);
const { spawnSync } = await import('node:child_process');
for (const t of typos) {
  const r = spawnSync(process.execPath, ['scripts/merge-locality.js', `--from=${t.from.id}`, `--into=${t.into.id}`, '--apply'], { encoding: 'utf8' });
  console.log(`  merged "${t.from.canonicalName}" into "${t.into.canonicalName}": ${r.status === 0 ? 'ok' : (r.stderr || r.stdout).trim().split('\n').pop()}`);
}
await prisma.$disconnect();
