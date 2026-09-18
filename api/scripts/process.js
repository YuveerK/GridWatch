import { prisma } from '../src/db/prisma.js';
import { processPending, resetLearnedState } from '../src/modules/processing/processor.service.js';

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

if (args.includes('--reset')) {
  await resetLearnedState();
  console.log('learned state reset');
}
console.log(await processPending({ limit }));
await prisma.$disconnect();
