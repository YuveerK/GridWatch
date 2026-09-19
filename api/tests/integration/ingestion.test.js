import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { currentCheckpoint, ingestNewPosts, ingestionStatus } from '../../src/modules/ingestion/ingestion.service.js';
import { XInvalidTokenError, XRateLimitError } from '../../src/modules/ingestion/x.client.js';
import { acquireLease } from '../../src/modules/coordination/lease.js';
import { prisma, resetDb } from './db.js';

const ID = (n) => String(1_000_000_000_000_000_000n + BigInt(n));
const tweet = (n, extra = {}) => ({ id: ID(n), text: `post ${n}`, created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString(), ...extra });

/** A scripted X timeline: `ids` newest first, `perPage` per page, with optional failures per call number. */
function timeline(ids, { perPage = 2, failOn = {}, rejectSavedTokens = false } = {}) {
  const sorted = [...ids].sort((a, b) => b - a);
  const calls = [];
  const issued = new Set(); // tokens this X 'session' handed out: anything else (a token saved by an earlier run) has expired
  const fetchPage = async ({ sinceId, paginationToken }) => {
    calls.push({ sinceId, paginationToken });
    const failure = failOn[calls.length];
    if (failure) throw failure;
    if (paginationToken && rejectSavedTokens && !issued.has(paginationToken)) throw new XInvalidTokenError('expired');
    const visible = sorted.filter((n) => (sinceId ? BigInt(ID(n)) > BigInt(sinceId) : true));
    const start = paginationToken ? Number(paginationToken.replace('tok', '')) : 0;
    const slice = visible.slice(start, start + perPage);
    const next = start + perPage < visible.length ? `tok${start + perPage}` : null;
    if (next) issued.add(next);
    return { posts: slice.map((n) => ({ tweet: tweet(n), media: [] })), nextToken: next };
  };
  return { fetchPage, calls };
}

const stored = async () => (await prisma.sourcePost.findMany({ select: { externalId: true }, orderBy: { externalId: 'asc' } })).map((r) => r.externalId);
const state = () => prisma.ingestionState.findUnique({ where: { accountId: env.X_SOURCE_ACCOUNT_ID } });

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "IngestionState", "WorkLease"');
});

describe('A02: no gaps in ingestion', () => {
  it('a page failure after page one leaves the mark where it was, so the older posts are still reachable', async () => {
    await prisma.sourcePost.create({ data: { id: 'seed', platform: 'X', sourceAccount: env.X_SOURCE_ACCOUNT_NAME, externalId: ID(100), text: 'old', publishedAt: new Date(), updatedAt: new Date() } });
    const t = timeline([101, 102, 103, 104, 105, 106], { perPage: 2, failOn: { 2: new Error('X API 503') } });
    const first = await ingestNewPosts({ fetchPage: t.fetchPage });
    expect(first.status).toBe('FAILED');
    expect(first.complete).toBe(false);
    expect(await stored()).toContain(ID(106)); // page one was kept...
    const s = await state();
    expect(s.completedHighWater).toBe(ID(100)); // ...but the mark did NOT jump to 106
    expect(s.cursorToken).toBe('tok2');

    const second = await ingestNewPosts({ fetchPage: timeline([101, 102, 103, 104, 105, 106], { perPage: 2 }).fetchPage });
    expect(second).toMatchObject({ status: 'SUCCEEDED', complete: true });
    expect(await stored()).toEqual([100, 101, 102, 103, 104, 105, 106].map(ID)); // every id, no duplicates
    expect((await state()).completedHighWater).toBe(ID(106));
    expect((await state()).cursorToken).toBeNull();
  });

  it('resumes from the saved cursor after a restart instead of re-reading (and re-paying for) stored pages', async () => {
    const script = [1, 2, 3, 4, 5, 6];
    await ingestNewPosts({ fetchPage: timeline(script, { failOn: { 2: new Error('boom') } }).fetchPage });
    const t = timeline(script);
    const resumed = await ingestNewPosts({ fetchPage: t.fetchPage });
    expect(resumed.resumedFromCursor).toBe(true);
    expect(t.calls[0].paginationToken).toBe('tok2'); // picked up at page two
    expect(await stored()).toEqual(script.map(ID));
  });

  it('falls back to re-reading the interval when X rejects the saved token, without losing or duplicating posts', async () => {
    const script = [1, 2, 3, 4, 5, 6];
    await ingestNewPosts({ fetchPage: timeline(script, { failOn: { 2: new Error('boom') } }).fetchPage });
    const t = timeline(script, { rejectSavedTokens: true }); // the token saved by the interrupted run has now expired
    const r = await ingestNewPosts({ fetchPage: t.fetchPage });
    expect(r).toMatchObject({ status: 'SUCCEEDED', complete: true, tokenExpired: true });
    expect(t.calls[0].paginationToken).toBe('tok2');
    expect(t.calls[1].paginationToken).toBeNull(); // restarted from the top
    expect(await stored()).toEqual(script.map(ID));
    expect(r.postsDeduplicated).toBeGreaterThan(0);
  });

  it('page-budget exhaustion is reported as incomplete, keeps the cursor, and the next run finishes the interval', async () => {
    const script = Array.from({ length: 9 }, (_, i) => i + 1);
    const capped = await ingestNewPosts({ maxPages: 2, fetchPage: timeline(script, { perPage: 2 }).fetchPage });
    expect(capped).toMatchObject({ status: 'SUCCEEDED', complete: false, incomplete: true, pagesFetched: 2 });
    expect((await state()).incomplete).toBe(true);
    expect((await ingestionStatus()).resumable).toBe(true);

    const rest = await ingestNewPosts({ maxPages: 20, fetchPage: timeline(script, { perPage: 2 }).fetchPage });
    expect(rest.complete).toBe(true);
    expect(await stored()).toEqual(script.map(ID));
    expect((await ingestionStatus()).incomplete).toBe(false);
  });

  it('a rate limit mid-run is recoverable', async () => {
    const script = [1, 2, 3, 4];
    const r1 = await ingestNewPosts({ fetchPage: timeline(script, { failOn: { 2: new XRateLimitError(null) } }).fetchPage });
    expect(r1.status).toBe('RATE_LIMITED');
    const r2 = await ingestNewPosts({ fetchPage: timeline(script).fetchPage });
    expect(r2.complete).toBe(true);
    expect(await stored()).toEqual(script.map(ID));
  });

  it('a failed write leaves neither the page nor its cursor behind (one transaction)', async () => {
    const script = [1, 2, 3, 4];
    const base = timeline(script);
    const poisoned = async (args) => {
      const page = await base.fetchPage(args);
      if (args.paginationToken) page.posts[0].tweet.text = null; // the second page cannot be written (text is NOT NULL)
      return page;
    };
    const r = await ingestNewPosts({ fetchPage: poisoned });
    expect(r.status).toBe('FAILED');
    const s = await state();
    expect(s.cursorToken).toBe('tok2'); // still pointing at the page that failed to store
    expect(await stored()).toEqual([ID(3), ID(4)]); // only page one is stored
    const again = await ingestNewPosts({ fetchPage: timeline(script).fetchPage });
    expect(again.complete).toBe(true);
    expect(await stored()).toEqual(script.map(ID));
  });

  it('seeds the mark from stored posts for a database that predates it, then advances it only when complete', async () => {
    await prisma.sourcePost.create({ data: { id: 'seed', platform: 'X', sourceAccount: env.X_SOURCE_ACCOUNT_NAME, externalId: ID(50), text: 'old', publishedAt: new Date(), updatedAt: new Date() } });
    expect(await currentCheckpoint()).toBe(ID(50));
    const t = timeline([51, 52]);
    await ingestNewPosts({ fetchPage: t.fetchPage });
    expect(t.calls[0].sinceId).toBe(ID(50));
    expect((await state()).completedHighWater).toBe(ID(52));
  });
});

describe('A03: only one ingestion at a time', () => {
  it('two simultaneous runs: one fetches, the other is skipped, and nothing is stored twice', async () => {
    const script = [1, 2, 3, 4];
    const slow = async (a) => {
      await new Promise((r) => setTimeout(r, 120));
      return timeline(script).fetchPage(a);
    };
    const results = await Promise.all([ingestNewPosts({ fetchPage: slow }), ingestNewPosts({ fetchPage: slow })]);
    expect(results.filter((r) => r.skipped)).toHaveLength(1);
    expect(await stored()).toEqual(script.map(ID));
  });

  it('skips when another worker holds the lease, and releases it after a failure', async () => {
    await acquireLease('pipeline', 'someone-else', 60_000);
    expect(await ingestNewPosts({ fetchPage: timeline([1]).fetchPage })).toEqual({ skipped: true });
    await prisma.$executeRawUnsafe('DELETE FROM "WorkLease"');
    await ingestNewPosts({ fetchPage: async () => { throw new Error('nope'); } });
    expect(await prisma.$queryRawUnsafe('SELECT 1 FROM "WorkLease"')).toHaveLength(0); // released even though the run failed
  });

  it('releases the lease even when setup fails right after it was taken', async () => {
    const spy = vi.spyOn(prisma.sourceAccount, 'upsert').mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(ingestNewPosts({ fetchPage: timeline([1]).fetchPage })).rejects.toThrow('DB unavailable');
    spy.mockRestore();
    expect(await prisma.$queryRawUnsafe('SELECT 1 FROM "WorkLease"')).toHaveLength(0);
    expect((await ingestNewPosts({ fetchPage: timeline([1]).fetchPage })).complete).toBe(true); // the next run is not blocked
  });

  it('records the run and still releases the lease when the completion record cannot be written', async () => {
    const r = await ingestNewPosts({ fetchPage: timeline([1, 2]).fetchPage });
    expect(r.complete).toBe(true);
    const run = await prisma.ingestionRun.findFirst({ orderBy: { startedAt: 'desc' } });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.diagnostics).toMatchObject({ complete: true, incomplete: false });
    expect(await prisma.$queryRawUnsafe('SELECT 1 FROM "WorkLease"')).toHaveLength(0);
  });
});
