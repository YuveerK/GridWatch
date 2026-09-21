// The saved quality results of processing cycles.
//   npm run quality              the latest cycle, with every problem it found
//   npm run quality -- --list    the last 20 cycles, one line each
// Exit status: 0 COMPLETE, 1 FAILED / NEEDS_REVIEW, 2 INCOMPLETE, 3 nothing recorded yet. Suitable for automation.
import { prisma } from '../src/db/prisma.js';

const short = (d) => new Date(d).toISOString().slice(5, 19).replace('T', ' ');
if (process.argv.includes('--list')) {
  const rows = await prisma.cycleQuality.findMany({ orderBy: { finishedAt: 'desc' }, take: 20 });
  for (const r of rows) console.log(`${short(r.finishedAt)}  ${r.status.padEnd(12)} ${r.trigger.padEnd(9)} posts ${String(r.summary.posts).padStart(3)}  faults ${String(r.summary.faultsWithDisposition).padStart(3)}/${String(r.summary.expectedFaults).padEnd(3)}  problems ${r.summary.problems}`);
  await prisma.$disconnect();
  process.exit(0);
}
const row = await prisma.cycleQuality.findFirst({ orderBy: { finishedAt: 'desc' } });
if (!row) {
  console.log('No cycle has been assessed yet (the first one is recorded after the next fetch).');
  await prisma.$disconnect();
  process.exit(3);
}
const s = row.summary;
console.log(`LATEST CYCLE: ${row.status}   (${row.trigger}, finished ${short(row.finishedAt)} UTC)`);
console.log(`  posts covered ${s.posts} | faults with an accepted disposition ${s.faultsWithDisposition} of ${s.expectedFaults} | outages changed ${s.outagesChanged}`);
console.log(`  needs review ${s.needsReview} | waiting (backlog) ${s.backlog} | stuck ${s.stuck}${s.incomplete?.length ? ` | stages that did not run: ${s.incomplete.join(', ')}` : ''}${s.ingestionIncomplete ? ' | the fetch did not finish' : ''}`);
if (s.error) console.log(`  ERROR: ${s.error}`);
for (const p of row.problems.slice(0, 40)) console.log(`  - [${p.kind}] ${p.externalId ? `${p.externalId.slice(-8)}: ` : ''}${p.message}`);
if (row.problems.length > 40) console.log(`  ... and ${row.problems.length - 40} more`);
await prisma.$disconnect();
process.exit({ COMPLETE: 0, INCOMPLETE: 2 }[row.status] ?? 1);
