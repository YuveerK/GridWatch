// Audit evidence for 861f807. Passing asserts the observed limitation, not desired behavior.
// Uses the repository's disposable database setup. AI and cache writes are mocked.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const readings = new Map();
vi.mock('../src/modules/ai/extraction.service.js', async (orig) => ({ ...(await orig()), extractPost: async (id) => readings.get(id) }));
vi.mock('../src/modules/ai/gemini.client.js', () => ({ generateJson: async ({ parts }) => ({ text: JSON.stringify({ outage_id: JSON.parse(parts[0].text).candidate_outages[0].outage_id, reason: 'same equipment' }) }) }));
vi.mock('../src/modules/outages/tiebreak-cache.js', () => ({ cachedVerdict: () => undefined, storeVerdict: () => {} }));

import { prisma, resetDb } from '../tests/integration/db.js';
import { processPost, reprocessPost, faultItems } from '../src/modules/processing/processor.service.js';
import { resetLocalityIndex } from '../src/modules/infrastructure/infrastructure.service.js';
import { snapshotForPosts, restoreSnapshot } from '../src/modules/processing/repair.js';
import { checkPostDispositions, assessCycle } from '../src/modules/processing/quality.js';
import { createCycle } from '../src/modules/processing/cycle.js';
import { verifyItem, callsLeftToday } from '../src/modules/review/verifier.js';
import { env } from '../src/config/env.js';

const T = new Date('2026-09-21T10:00:00Z');
async function add(id, minute) {
  const result = { relevance: 'OUTAGE', status: 'INVESTIGATING', sdc: 'Test SDC',
    entities: [{ type: 'SUBSTATION', name: 'Alpha', parent_name: null }],
    localities: [], faults: [], restoration_percent: null, confidence: 0.95 };
  const reading = { status: 'SUCCEEDED', relevance: 'OUTAGE', result };
  await prisma.sourcePost.create({ data: { id, externalId: id, conversationId: id, platform: 'X', sourceAccount: 'test',
    text: 'Alpha substation outage', publishedAt: new Date(+T + minute * 60_000), updatedAt: T } });
  await prisma.postExtraction.create({ data: { postId: id, promptVersion: env.AI_PROMPT_VERSION, model: 'test', ...reading } });
  readings.set(id, reading);
}
beforeEach(async () => { await resetDb(); resetLocalityIndex(); readings.clear(); });
afterEach(() => vi.restoreAllMocks());

it('NEW with an outage ID but no timeline entry is accepted', () => {
  expect(checkPostDispositions({ expectedIndices: [0], decisions: [{ faultIndex: 0, outcome: 'NEW', outageId: 'o' }], outagePosts: [] }).problems).toEqual([]);
});

it('an extra timeline assignment for the same fault is accepted', () => {
  expect(checkPostDispositions({ expectedIndices: [0], decisions: [{ faultIndex: 0, outcome: 'LINKED', outageId: 'a' }], outagePosts: [{ faultIndex: 0, outageId: 'a' }, { faultIndex: 0, outageId: 'b' }] }).problems).toEqual([]);
});

it('undo overwrites evidence contributed by a post that arrived after the snapshot', async () => {
  await add('100', 0); await processPost('100');
  await add('200', 1); await processPost('200');
  const snapshot = await snapshotForPosts(prisma, ['200']);
  await reprocessPost('200');
  await add('300', 2); await processPost('300');
  expect((await prisma.infraNode.findFirst({ where: { normalizedKey: 'alpha' } })).evidenceCount).toBe(3);
  await restoreSnapshot({ prisma, snapshot });
  const node = await prisma.infraNode.findFirst({ where: { normalizedKey: 'alpha' } });
  expect(node.evidenceCount).toBe(2);
  expect(await prisma.evidenceContribution.count({ where: { kind: 'NODE', refA: node.id } })).toBe(3);
});

it('quality reports COMPLETE for a covered post with an open high-priority review item', async () => {
  const startedAt = new Date(Date.now() - 60_000);
  await add('100', 0); await processPost('100');
  await prisma.reviewItem.create({ data: { postId: '100', faultIndex: 0, priority: 10, reasons: [{ code: 'KIND_CONFLICT' }] } });
  const result = await assessCycle({ prisma, faultItems, promptVersion: env.AI_PROMPT_VERSION, trigger: 'audit', startedAt });
  expect(result.status).toBe('COMPLETE');
  expect(result.summary.needsReview).toBe(0);
  expect(await prisma.reviewItem.count({ where: { status: 'OPEN' } })).toBe(1);
});

it('failure of the quality assessor still reports a done cycle with no saved result', async () => {
  const cycle = createCycle({
    counts: async () => ({ outages: 0, outagePosts: 0 }),
    ingest: async () => ({ status: 'SUCCEEDED' }),
    process: async () => ({ total: 0 }), sweep: async () => ({}),
    assess: async () => { throw new Error('quality database failure'); },
  });
  await cycle.runNow();
  expect(cycle.status().state).toBe('done');
  expect(cycle.status().result.quality).toBeNull();
});

it('rechecking one item exceeds the daily verifier call cap', async () => {
  await add('100', 0);
  const item = await prisma.reviewItem.create({ data: { postId: '100', priority: 1, reasons: [{ code: 'SAMPLE' }] } });
  const generate = vi.fn(async () => ({ text: JSON.stringify({ verdict: 'AGREE', evidence_quote: 'Alpha substation outage', reason: 'test' }) }));
  for (let i = 0; i < 3; i++) await verifyItem({ prisma, item, generate, force: true, maxPerDay: 2 });
  expect(generate).toHaveBeenCalledTimes(3);
  expect(await callsLeftToday(prisma, new Date(), 2)).toBe(1);
});

it('two simultaneously invoked calls can safely finish without a BUSY response when the second database request is delayed', async () => {
  await add('100', 0);
  const real = prisma.$queryRawUnsafe.bind(prisma);
  let acquisitions = 0;
  let first;
  vi.spyOn(prisma, '$queryRawUnsafe').mockImplementation(async (sql, ...args) => {
    if (sql.startsWith('INSERT INTO "WorkLease"') && ++acquisitions === 2) await first;
    return real(sql, ...args);
  });
  first = processPost('100');
  const second = processPost('100');
  const results = await Promise.all([first, second]);
  expect(results.map((r) => r.outcome)).toEqual(['NEW', 'ALREADY_LINKED']);
  expect(await prisma.outage.count()).toBe(1);
  expect(await prisma.linkDecision.count()).toBe(1);
  expect((await prisma.infraNode.findFirst({ where: { normalizedKey: 'alpha' } })).evidenceCount).toBe(1);
});
