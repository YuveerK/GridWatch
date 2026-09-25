import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/ai/extraction.service.js', () => ({
  extractPost: async () => ({ status: 'FAILED', result: null }),
  faultLayout: () => 1,
}));

import { withLease, PIPELINE } from '../../src/modules/coordination/lease.js';
import { backfillAccount } from '../../src/modules/ingestion/ingestion.service.js';
import { processPending } from '../../src/modules/processing/processor.service.js';
import { prisma, resetDb } from './db.js';

const FROM = new Date('2026-09-01T00:00:00+02:00');
const TO = new Date('2026-09-24T00:00:00+02:00');
const at = (iso) => new Date(iso);

function page(posts, nextToken = null) {
  return { posts: posts.map((p) => ({ tweet: { id: p.id, text: p.text, created_at: p.at, author_id: '999' }, media: p.media ?? [] })), nextToken };
}

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "IngestionState", "WorkLease", "SourceAccount" CASCADE');
  await prisma.sourceAccount.create({
    data: { id: 'jw', platform: 'X', externalId: '999', displayName: 'JHBWater', serviceType: 'WATER', active: false, updatedAt: new Date() },
  });
});

describe('Johannesburg Water historical backfill', () => {
  const script = [
    { id: '40', text: 'sep 25', at: '2026-09-25T08:00:00+02:00' },
    { id: '30', text: 'sep 5', at: '2026-09-05T08:00:00+02:00' },
    { id: '20', text: 'sep 1', at: '2026-09-01T00:00:00+02:00' },
    { id: '10', text: 'aug 31', at: '2026-08-31T22:00:00+02:00' },
  ];

  it('keeps only posts inside the requested window', async () => {
    let calls = 0;
    const result = await backfillAccount({
      handle: 'JHBWater',
      from: FROM,
      to: TO,
      fetchPage: async () => page(calls++ === 0 ? script : []),
    });
    expect(result.complete).toBe(true);
    const rows = await prisma.sourcePost.findMany({ orderBy: { publishedAt: 'asc' } });
    expect(rows.map((r) => r.externalId)).toEqual(['20', '30']);
    expect(rows.every((r) => r.serviceType === 'WATER')).toBe(true);
    const state = await prisma.ingestionState.findUnique({ where: { accountId: '999' } });
    expect(state.completedHighWater).toBe('30');
    expect(state.incomplete).toBe(false);
  });

  it('a second run inserts nothing new', async () => {
    const fetchPage = async () => page(script);
    await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, fetchPage });
    const again = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, fetchPage });
    expect(again.postsInserted).toBe(0);
    expect(await prisma.sourcePost.count()).toBe(2);
  });

  it('an interrupted fetch resumes from the saved page', async () => {
    const seen = [];
    const fetchPage = async ({ paginationToken }) => {
      seen.push(paginationToken ?? 'start');
      if (!paginationToken) return page([script[0], script[1]], 'next');
      return page([script[2], script[3]], null);
    };
    const first = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, maxPosts: 1, fetchPage });
    expect(first.ceiling).toBe(true);
    expect(first.complete).toBe(false);
    const state = await prisma.ingestionState.findUnique({ where: { accountId: '999' } });
    expect(state?.completedHighWater ?? null).toBeNull();
    const saved = await prisma.ingestionRun.findFirst({ orderBy: { startedAt: 'desc' } });
    expect(saved.diagnostics.cursorToken).toBe('next');
    expect((await processPending({ sourceAccount: 'JHBWater', limit: 0 })).held).toBe(1);
    const second = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, fetchPage });
    expect(second.resumed).toBe(true);
    expect(second.complete).toBe(true);
    expect(seen[1]).toBe('next');
    expect((await processPending({ sourceAccount: 'JHBWater', limit: 0 })).held).toBe(0);
    const rows = await prisma.sourcePost.findMany({ orderBy: { externalId: 'asc' } });
    expect(rows.map((r) => r.externalId)).toEqual(['20', '30']);
  });

  it('stores a whole final page even when it crosses the soft post ceiling', async () => {
    const result = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, maxPosts: 1,
      fetchPage: async () => page([script[1], script[2]]) });
    expect(result).toMatchObject({ complete: true, ceiling: false, postsInserted: 2 });
    expect((await prisma.sourcePost.findMany({ orderBy: { externalId: 'asc' } })).map((p) => p.externalId)).toEqual(['20', '30']);
    expect((await prisma.ingestionState.findUnique({ where: { accountId: '999' } })).completedHighWater).toBe('30');
  });

  it('resumes after a whole capped page without refetching that page', async () => {
    const seen = [];
    const fetchPage = async ({ paginationToken }) => {
      seen.push(paginationToken ?? 'start');
      return paginationToken ? page([{ id: '15', text: 'sep 2', at: '2026-09-02T00:00:00+02:00' }]) : page([script[1], script[2]], 'next');
    };
    const first = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, maxPosts: 1, fetchPage });
    expect(first).toMatchObject({ complete: false, ceiling: true, postsInserted: 2 });
    const second = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, maxPosts: 1, fetchPage });
    expect(second).toMatchObject({ resumed: true, complete: true, postsInserted: 1, postsDeduplicated: 0 });
    expect(seen).toEqual(['start', 'next']);
  });

  it('does not advance an established live mark over a historical gap', async () => {
    await prisma.ingestionState.create({ data: { accountId: '999', completedHighWater: '10', incomplete: false } });
    await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, fetchPage: async () => page([script[1]]) });
    expect((await prisma.ingestionState.findUnique({ where: { accountId: '999' } })).completedHighWater).toBe('10');
  });

  it('uses the original upper bound for --to now resumes, and a changed explicit bound starts afresh', async () => {
    const fetchPage = async () => page([script[1]], 'next');
    const first = await backfillAccount({ handle: 'JHBWater', from: FROM, maxPosts: 1, fetchPage });
    const seen = [];
    const second = await backfillAccount({ handle: 'JHBWater', from: FROM, maxPosts: 1,
      fetchPage: async (args) => { seen.push(args); return page([]); } });
    expect(second.resumed).toBe(true);
    expect(seen[0].endTime.toISOString()).toBe(first.to.toISOString());
    expect(seen[0].paginationToken).toBe('next');
    const changed = await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO,
      fetchPage: async (args) => { seen.push(args); return page([]); } });
    expect(changed.resumed).toBe(false);
    expect(seen[1].paginationToken).toBeNull();
    expect(seen[1].endTime.toISOString()).toBe(TO.toISOString());
  });

  it('does not touch an electricity outage', async () => {
    const power = await prisma.outage.create({ data: { title: 'Willowbrook power', serviceType: 'ELECTRICITY', status: 'ACTIVE', startedAt: at('2026-09-02T00:00:00+02:00'), lastUpdateAt: at('2026-09-02T00:00:00+02:00') } });
    await backfillAccount({ handle: 'JHBWater', from: FROM, to: TO, fetchPage: async () => page(script) });
    const still = await prisma.outage.findUnique({ where: { id: power.id } });
    expect(still.serviceType).toBe('ELECTRICITY');
    expect(still.title).toBe('Willowbrook power');
  });
});

describe('historical water processing order', () => {
  const mk = (id, account, service, iso) => prisma.sourcePost.create({
    data: { id, platform: 'X', sourceAccount: account, serviceType: service, externalId: id, text: id, publishedAt: at(iso), updatedAt: at(iso), processingStatus: 'UNPROCESSED' },
  });

  it('processes the oldest pending water posts and leaves electricity alone', async () => {
    await mk('w2', 'JHBWater', 'WATER', '2026-09-05T00:00:00+02:00');
    await mk('w1', 'JHBWater', 'WATER', '2026-09-01T00:00:00+02:00');
    await mk('e1', 'CityPowerJhb', 'ELECTRICITY', '2026-09-01T00:00:00+02:00');
    const result = await processPending({ serviceType: 'WATER', sourceAccount: 'JHBWater', from: FROM, limit: 1, ignoreIncomplete: true });
    expect(result.attempted).toBe(1);
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w1' } })).processingStatus).not.toBe('UNPROCESSED');
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w2' } })).processingStatus).toBe('UNPROCESSED');
    expect((await prisma.sourcePost.findUnique({ where: { id: 'e1' } })).processingStatus).toBe('UNPROCESSED');
    expect(await prisma.outage.count({ where: { serviceType: 'ELECTRICITY' } })).toBe(0);
  });

  it('limit 100 stops at 100, and a missing limit processes every eligible post', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `w${String(i).padStart(3, '0')}`,
      platform: 'X',
      sourceAccount: 'JHBWater',
      serviceType: 'WATER',
      externalId: `w${String(i).padStart(3, '0')}`,
      text: 'notice',
      publishedAt: new Date(FROM.getTime() + i * 60_000),
      updatedAt: new Date(),
      processingStatus: 'UNPROCESSED',
    }));
    await prisma.sourcePost.createMany({ data: rows });
    await mk('before', 'JHBWater', 'WATER', '2026-08-31T22:00:00+02:00');
    await mk('other-water', 'OtherWater', 'WATER', '2026-09-02T00:00:00+02:00');
    await mk('jw-power', 'JHBWater', 'ELECTRICITY', '2026-09-02T00:00:00+02:00');
    await mk('city-power', 'CityPowerJhb', 'ELECTRICITY', '2026-09-02T00:00:00+02:00');

    const capped = await processPending({ serviceType: 'WATER', sourceAccount: 'JHBWater', from: FROM, limit: 100, ignoreIncomplete: true });
    expect(capped.skipped).toBeUndefined();
    expect(capped.attempted).toBe(100);
    expect(capped.total).toBe(100);
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w000' } })).processingStatus).not.toBe('UNPROCESSED');
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w099' } })).processingStatus).not.toBe('UNPROCESSED');
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w100' } })).processingStatus).toBe('UNPROCESSED');

    const rest = await processPending({ serviceType: 'WATER', sourceAccount: 'JHBWater', from: FROM, ignoreIncomplete: true });
    expect(rest.skipped).toBeUndefined();
    expect(rest.total).toBeGreaterThan(0);
    expect(rest.attempted).toBe(rest.total);
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w100' } })).processingStatus).not.toBe('UNPROCESSED');
    for (const id of ['before', 'other-water', 'jw-power', 'city-power']) {
      expect((await prisma.sourcePost.findUnique({ where: { id } })).processingStatus).toBe('UNPROCESSED');
    }
    expect(await prisma.outage.count({ where: { serviceType: 'ELECTRICITY' } })).toBe(0);
  });

  it('a held pipeline lease skips before any limit is applied', async () => {
    await mk('w1', 'JHBWater', 'WATER', '2026-09-02T00:00:00+02:00');
    const outcome = await withLease(PIPELINE, () => processPending({ serviceType: 'WATER', sourceAccount: 'JHBWater', from: FROM, ignoreIncomplete: true }));
    expect(outcome.value).toEqual({ skipped: true, total: 0, attempted: 0, tally: {}, remaining: null, held: null });
    expect((await prisma.sourcePost.findUnique({ where: { id: 'w1' } })).processingStatus).toBe('UNPROCESSED');
  });
});
