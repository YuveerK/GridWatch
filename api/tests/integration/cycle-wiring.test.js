import { beforeEach, describe, expect, it } from 'vitest';

const { createCycle, sweepStage } = await import('../../src/modules/processing/cycle.js');
const { withLease, PIPELINE } = await import('../../src/modules/coordination/lease.js');
const { prisma, resetDb } = await import('./db.js');

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "WorkLease" CASCADE');
});

describe('E07: the refresh really runs its cleanup under its own lease', () => {
  it('an outage with no news for days becomes STALE during a refresh, and the refresh is not reported incomplete', async () => {
    const old = new Date(Date.now() - 10 * 24 * 3_600_000);
    const o = await prisma.outage.create({ data: { title: 'Old fault', kind: 'UNPLANNED', status: 'ACTIVE', startedAt: old, lastUpdateAt: old } });
    // the real lease, the real sweep stage; only fetching and reading are faked
    const cycle = createCycle({
      lease: (fn) => withLease(PIPELINE, fn),
      sweep: sweepStage,
      counts: async () => ({ outages: 1, outagePosts: 0 }),
      ingest: async () => ({ status: 'SUCCEEDED', postsFetched: 0, postsInserted: 0 }),
      process: async () => ({ total: 0, attempted: 0, tally: {}, remaining: 0 }),
    });
    await cycle.runNow();
    expect(cycle.status()).toMatchObject({ state: 'done', result: { incomplete: [] } });
    expect((await prisma.outage.findUnique({ where: { id: o.id } })).status).toBe('STALE');
  });
});
