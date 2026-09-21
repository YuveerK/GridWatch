// Characterization tests: reproduce defects in a disposable database; never run against application data.
import { beforeEach, expect, it, vi } from 'vitest';

const readings = new Map();
vi.mock('../src/modules/ai/extraction.service.js', async (orig) => ({
  ...(await orig()), extractPost: async (id) => readings.get(id),
}));
vi.mock('../src/modules/ai/gemini.client.js', () => ({
  generateJson: async ({ parts }) => ({ text: JSON.stringify({ outage_id: JSON.parse(parts[0].text).candidate_outages[0].outage_id, reason: 'same equipment' }) }),
}));
vi.mock('../src/modules/outages/tiebreak-cache.js', () => ({ cachedVerdict: () => undefined, storeVerdict: () => {} }));

import { prisma, resetDb } from '../tests/integration/db.js';
import { processPost, reprocessPost } from '../src/modules/processing/processor.service.js';
import { ingestNewPosts } from '../src/modules/ingestion/ingestion.service.js';
import { resetLocalityIndex } from '../src/modules/infrastructure/infrastructure.service.js';

const T = new Date('2026-09-21T10:00:00Z');
const reading = () => ({ status: 'SUCCEEDED', relevance: 'OUTAGE', result: {
  relevance: 'OUTAGE', status: 'INVESTIGATING', sdc: 'Test SDC',
  entities: [{ type: 'SUBSTATION', name: 'Alpha', parent_name: null }],
  localities: [], faults: [], restoration_percent: null,
} });
async function post(id, minute) {
  await prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'test', externalId: id, conversationId: id,
    text: 'Alpha substation outage', publishedAt: new Date(+T + minute * 60_000), updatedAt: T } });
  readings.set(id, reading());
}
beforeEach(async () => { await resetDb(); resetLocalityIndex(); readings.clear(); });

it('relinking the opening post with unchanged facts splits a two-post outage', async () => {
  await post('100', 0); await post('200', 1);
  await processPost('100'); await processPost('200');
  expect(await prisma.outage.count()).toBe(1);
  await reprocessPost('100');
  expect(await prisma.outage.count()).toBe(2);
  expect(new Set((await prisma.outagePost.findMany()).map((p) => p.outageId)).size).toBe(2);
});

it('a replacement reading needing review removes a previously published outage', async () => {
  await post('100', 0); await processPost('100');
  expect(await prisma.outage.count()).toBe(1);
  readings.set('100', { ...reading(), status: 'NEEDS_REVIEW' });
  await reprocessPost('100', { reextract: true });
  expect(await prisma.outage.count()).toBe(0);
  expect((await prisma.sourcePost.findUnique({ where: { id: '100' } })).processingStatus).toBe('NEEDS_REVIEW');
});

it('a worker without database lease ownership still writes infrastructure before link fencing rejects it', async () => {
  await post('100', 0);
  const ghost = { name: 'pipeline', owner: 'expired-owner', lost: false, assertHeld() {} };
  await expect(processPost('100', { ctx: ghost })).rejects.toThrow(/lease/);
  expect(await prisma.outage.count()).toBe(0);
  expect(await prisma.infraNode.count()).toBeGreaterThan(0);
  expect(await prisma.evidenceContribution.count()).toBeGreaterThan(0);
});

it('ingestion commits a page and checkpoint without checking database lease ownership', async () => {
  const ghost = { name: 'pipeline', owner: 'expired-owner', lost: false, assertHeld() {} };
  const result = await ingestNewPosts({ ctx: ghost, fetchPage: async () => ({ posts: [{ tweet: { id: '300', text: 'Alpha outage', created_at: T.toISOString() }, media: [] }], nextToken: null }) });
  expect(result.status).toBe('SUCCEEDED');
  expect(await prisma.sourcePost.count()).toBe(1);
  expect((await prisma.ingestionState.findFirst()).completedHighWater).toBe('300');
});
