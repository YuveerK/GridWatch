// Rebuild every outage from the stored readings, oldest post first (no AI is called for posts that already have a reading).
// Destructive: it deletes all outages, links and learned equipment first. Without --confirm it only reports what it would delete.
//   npm run relink                 report only
//   npm run relink -- --confirm    do it
import { prisma } from '../src/db/prisma.js';
import { processPending, resetLearnedState } from '../src/modules/processing/processor.service.js';

const confirm = process.argv.includes('--confirm');
const counts = {
  outages: await prisma.outage.count(),
  timelineEntries: await prisma.outagePost.count(),
  linkDecisions: await prisma.linkDecision.count(),
  learnedEquipment: await prisma.infraNode.count(),
  postsWithReading: await prisma.postExtraction.count({ where: { status: 'SUCCEEDED' } }),
  postsTotal: await prisma.sourcePost.count(),
};
console.log(confirm ? 'Rebuilding. Current contents:' : 'Dry run. This would delete and rebuild:', counts);
if (!confirm) {
  console.log('Posts without a stored reading would be sent to the AI (paid). Re-run with --confirm to proceed.');
} else {
  await resetLearnedState();
  console.log(await processPending());
}
await prisma.$disconnect();
