import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';

// One database-backed lock shared by every entry point that changes posts, outages or the learned graph:
// the scheduler, the refresh button, the admin routes and the command-line scripts. Linking has to see posts in
// time order and must never process the same post twice, so a single writer at a time is the simplest correct rule.
//
// Times are compared with the database clock (never the app's), and stored as naive UTC like the rest of the schema.

export const PIPELINE = 'pipeline';
const DEFAULT_TTL_MS = 120_000;
const UTC_NOW = 'timezone(\'UTC\', now())';

export class LeaseLostError extends Error {
  constructor(name) {
    super(`lost the "${name}" lease: another worker may have taken over, so this work must stop`);
    this.name = 'LeaseLostError';
  }
}

/** Atomic: exactly one caller can take a free or expired lease, however many race for it. */
export async function acquireLease(name, owner, ttlMs = DEFAULT_TTL_MS) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "WorkLease" ("name","owner","acquiredAt","expiresAt","renewedAt")
     VALUES ($1, $2, ${UTC_NOW}, ${UTC_NOW} + ($3::double precision * interval '1 millisecond'), ${UTC_NOW})
     ON CONFLICT ("name") DO UPDATE
       SET "owner" = EXCLUDED."owner", "acquiredAt" = ${UTC_NOW}, "expiresAt" = EXCLUDED."expiresAt", "renewedAt" = ${UTC_NOW}
       WHERE "WorkLease"."expiresAt" <= ${UTC_NOW}
     RETURNING "owner"`,
    name,
    owner,
    ttlMs,
  );
  return rows.length === 1 && rows[0].owner === owner;
}

/** Only the current, unexpired owner can extend the lease. */
export async function renewLease(name, owner, ttlMs = DEFAULT_TTL_MS) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "WorkLease" SET "expiresAt" = ${UTC_NOW} + ($3::double precision * interval '1 millisecond'), "renewedAt" = ${UTC_NOW}
     WHERE "name" = $1 AND "owner" = $2 AND "expiresAt" > ${UTC_NOW}
     RETURNING "owner"`,
    name,
    owner,
    ttlMs,
  );
  return rows.length === 1;
}

/** Deletes only our own row: a worker that lost its lease must never remove its successor's. */
export async function releaseLease(name, owner) {
  const n = await prisma.$executeRawUnsafe('DELETE FROM "WorkLease" WHERE "name" = $1 AND "owner" = $2', name, owner);
  return n === 1;
}

/**
 * Inside a transaction: prove we still hold the lease at commit time. `FOR SHARE` also stops a successor from taking
 * the lease over until this transaction ends, so an expired worker cannot slip a final write in.
 */
export async function assertLeaseInTx(tx, ctx) {
  if (!ctx) return;
  const rows = await tx.$queryRawUnsafe(`SELECT 1 FROM "WorkLease" WHERE "name" = $1 AND "owner" = $2 AND "expiresAt" > ${UTC_NOW} FOR SHARE`, ctx.name, ctx.owner);
  if (rows.length !== 1) {
    ctx.lost = true;
    throw new LeaseLostError(ctx.name);
  }
}

/**
 * Run `fn(ctx)` while holding the lease, renewing it on a timer. Returns { acquired: false } without running when someone
 * else holds it. `ctx.assertHeld()` throws LeaseLostError once the lease has been lost, `ctx.signal` aborts at that moment.
 * The lease is always released, on success or failure, and never deletes anyone else's.
 */
export async function withLease(name, fn, { ttlMs = DEFAULT_TTL_MS, heartbeatMs = Math.max(50, Math.floor(ttlMs / 4)), onLost } = {}) {
  const owner = randomUUID();
  if (!(await acquireLease(name, owner, ttlMs))) return { acquired: false };
  const abort = new AbortController();
  const ctx = {
    name,
    owner,
    lost: false,
    signal: abort.signal,
    assertHeld() {
      if (ctx.lost) throw new LeaseLostError(name);
    },
  };
  let lastOk = Date.now();
  const timer = setInterval(async () => {
    try {
      if (await renewLease(name, owner, ttlMs)) lastOk = Date.now();
      else throw new LeaseLostError(name);
    } catch (err) {
      // a database blip is tolerated until the lease would have expired anyway; a refused renewal is final
      if (err instanceof LeaseLostError || Date.now() - lastOk > ttlMs) {
        if (!ctx.lost) {
          ctx.lost = true;
          logger.error({ lease: name }, 'lease lost: stopping this work');
          abort.abort();
          onLost?.();
        }
        clearInterval(timer);
      }
    }
  }, heartbeatMs);
  timer.unref?.();
  try {
    return { acquired: true, value: await fn(ctx) };
  } finally {
    clearInterval(timer);
    try {
      await releaseLease(name, owner);
    } catch (err) {
      logger.warn({ err: err.message, lease: name }, 'could not release the lease; it will expire on its own');
    }
  }
}

/** Reuse a lease the caller already holds, or take one for the duration of `fn`. */
export async function exclusive(ctx, fn, opts) {
  if (ctx) return { acquired: true, value: await fn(ctx) };
  return withLease(PIPELINE, fn, opts);
}

/**
 * A crashed worker can leave posts marked PROCESSING. Because everything that processes posts holds the lease,
 * the moment we own it no other worker is mid-post, so anything still PROCESSING is stale work to requeue.
 */
export async function recoverStaleWork() {
  const { count } = await prisma.sourcePost.updateMany({ where: { processingStatus: 'PROCESSING' }, data: { processingStatus: 'UNPROCESSED' } });
  if (count) logger.warn({ count }, 'requeued posts left in PROCESSING by a worker that stopped');
  return count;
}
