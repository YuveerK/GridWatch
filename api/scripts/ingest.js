import { prisma } from '../src/db/prisma.js';
import { ingestNewPosts } from '../src/modules/ingestion/ingestion.service.js';
import { processPending } from '../src/modules/processing/processor.service.js';

console.log(await ingestNewPosts());
if (process.argv.includes('--process')) console.log(await processPending());
await prisma.$disconnect();
