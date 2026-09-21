import { beforeEach, describe, expect, it } from 'vitest';

const { latestNonemptyRuns } = await import('../../src/modules/processing/quality.js');
const { prisma, resetDb } = await import('./db.js');

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "IngestionRun", "SourceAccount" CASCADE');
});

describe('E11: the latest batch is found however many empty polls follow it', () => {
  it('six empty runs after a real one do not hide it, and the newest real ones come first', async () => {
    const { id: sourceAccountId } = await prisma.sourceAccount.create({ data: { id: 'acct', platform: 'X', externalId: 'acct', displayName: 'Test', updatedAt: new Date() } });
    const at = (min) => new Date(Date.UTC(2026, 8, 21, 10, min));
    const run = (id, min, inserted) => prisma.ingestionRun.create({ data: { id, sourceAccountId, startedAt: at(min), postsFetched: inserted, postsInserted: inserted, status: 'SUCCEEDED' } });
    await run('real-1', 0, 4);
    await run('real-2', 10, 2);
    for (let i = 0; i < 7; i++) await run(`empty-${i}`, 20 + i, 0);
    expect((await latestNonemptyRuns(prisma, 1)).map((r) => r.id)).toEqual(['real-2']);
    expect((await latestNonemptyRuns(prisma, 2)).map((r) => r.id)).toEqual(['real-2', 'real-1']);
  });
  it('none at all is an empty list, not a crash', async () => {
    expect(await latestNonemptyRuns(prisma, 1)).toEqual([]);
  });
});
