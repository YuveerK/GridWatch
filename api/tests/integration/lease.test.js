import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, assertLeaseInTx, LeaseLostError, recoverStaleWork, releaseLease, renewLease, withLease } from '../../src/modules/coordination/lease.js';
import { prisma, resetDb } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expire = (name) => prisma.$executeRawUnsafe(`UPDATE "WorkLease" SET "expiresAt" = timezone('UTC', now()) - interval '1 second' WHERE "name" = $1`, name);

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('DELETE FROM "WorkLease"');
});

describe('lease acquisition (real PostgreSQL connections)', () => {
  it('lets exactly one of many simultaneous callers win', async () => {
    const owners = Array.from({ length: 25 }, () => randomUUID());
    const results = await Promise.all(owners.map((o) => acquireLease('pipeline', o, 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const [row] = await prisma.$queryRawUnsafe('SELECT "owner" FROM "WorkLease" WHERE "name" = $1', 'pipeline');
    expect(owners[results.indexOf(true)]).toBe(row.owner);
  });

  it('refuses a second worker while the first holds an unexpired lease', async () => {
    expect(await acquireLease('pipeline', 'a', 60_000)).toBe(true);
    expect(await acquireLease('pipeline', 'b', 60_000)).toBe(false);
  });

  it('lets a successor take over after expiry, and the old owner can neither renew nor delete the new lease', async () => {
    expect(await acquireLease('pipeline', 'old', 60_000)).toBe(true);
    await expire('pipeline');
    expect(await acquireLease('pipeline', 'new', 60_000)).toBe(true);
    expect(await renewLease('pipeline', 'old', 60_000)).toBe(false);
    expect(await releaseLease('pipeline', 'old')).toBe(false); // must not remove the successor's lease
    const [row] = await prisma.$queryRawUnsafe('SELECT "owner" FROM "WorkLease" WHERE "name" = $1', 'pipeline');
    expect(row.owner).toBe('new');
  });

  it('cannot renew a lease that has already expired', async () => {
    await acquireLease('pipeline', 'a', 60_000);
    await expire('pipeline');
    expect(await renewLease('pipeline', 'a', 60_000)).toBe(false);
  });

  it('compares with the database clock in UTC, not the session time zone', async () => {
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'Africa/Johannesburg'`).catch(() => {});
    expect(await acquireLease('tz', 'a', 60_000)).toBe(true);
    expect(await acquireLease('tz', 'b', 60_000)).toBe(false); // a +2h skew would make this lease look already expired
  });
});

describe('withLease', () => {
  it('runs the work once for concurrent callers and reports the others as not acquired', async () => {
    let running = 0;
    let maxRunning = 0;
    const work = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(150);
      running--;
      return 'done';
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => withLease('pipeline', work, { ttlMs: 5000 })));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(maxRunning).toBe(1);
  });

  it('releases the lease when the work fails', async () => {
    await expect(withLease('pipeline', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await withLease('pipeline', async () => 1)).acquired).toBe(true);
  });

  it('keeps a long job alive by renewing, so a rival cannot take over mid-job', async () => {
    let rival = null;
    const job = await withLease('pipeline', async () => {
      await sleep(900); // several times the ttl
      rival = await acquireLease('pipeline', 'rival', 60_000);
      return 'finished';
    }, { ttlMs: 300, heartbeatMs: 60 });
    expect(job).toMatchObject({ acquired: true, value: 'finished' });
    expect(rival).toBe(false);
  });

  it('signals the old worker to stop when its lease is taken away, and does not delete the successor', async () => {
    let stoppedBy = null;
    const started = withLease('pipeline', async (ctx) => {
      await expire('pipeline');
      await acquireLease('pipeline', 'successor', 60_000);
      await sleep(400); // a heartbeat runs and is refused
      try {
        ctx.assertHeld();
      } catch (e) {
        stoppedBy = e;
      }
      return ctx.signal.aborted;
    }, { ttlMs: 5000, heartbeatMs: 60 });
    const result = await started;
    expect(result.value).toBe(true);
    expect(stoppedBy).toBeInstanceOf(LeaseLostError);
    const [row] = await prisma.$queryRawUnsafe('SELECT "owner" FROM "WorkLease" WHERE "name" = $1', 'pipeline');
    expect(row.owner).toBe('successor'); // the old worker's cleanup left it alone
  });

  it('a commit by a worker that lost its lease is refused inside the transaction', async () => {
    const result = await withLease('pipeline', async (ctx) => {
      await expire('pipeline');
      await acquireLease('pipeline', 'successor', 60_000);
      let outcome = 'committed';
      try {
        await prisma.$transaction(async (tx) => {
          await assertLeaseInTx(tx, ctx);
          await tx.sourceAccount.create({ data: { id: 'should-not-exist', platform: 'X', externalId: 'x', displayName: 'x', updatedAt: new Date() } });
        });
      } catch (e) {
        outcome = e.name;
      }
      return outcome;
    }, { ttlMs: 5000, heartbeatMs: 10_000 });
    expect(result.value).toBe('LeaseLostError');
    expect(await prisma.sourceAccount.count({ where: { id: 'should-not-exist' } })).toBe(0);
  });
});

describe('stale-work recovery', () => {
  it('requeues posts a crashed worker left in PROCESSING', async () => {
    await prisma.sourcePost.create({ data: { id: 'p1', platform: 'X', sourceAccount: 'a', externalId: '1', text: 't', publishedAt: new Date(), updatedAt: new Date(), processingStatus: 'PROCESSING' } });
    await prisma.sourcePost.create({ data: { id: 'p2', platform: 'X', sourceAccount: 'a', externalId: '2', text: 't', publishedAt: new Date(), updatedAt: new Date(), processingStatus: 'RELEVANT' } });
    expect(await recoverStaleWork()).toBe(1);
    expect((await prisma.sourcePost.findUnique({ where: { id: 'p1' } })).processingStatus).toBe('UNPROCESSED');
    expect((await prisma.sourcePost.findUnique({ where: { id: 'p2' } })).processingStatus).toBe('RELEVANT');
  });
});
