import { beforeEach, expect, it } from 'vitest';
import { prisma, resetDb } from './db.js';
import { assessCycle } from '../../src/modules/processing/quality.js';
import { faultItems } from '../../src/modules/processing/processor.service.js';
import { detectSuspicious } from '../../src/modules/review/review.service.js';
import { snapshotForPosts, restoreSnapshot } from '../../src/modules/processing/repair.js';
import { refoldOutage } from '../../src/modules/outages/outage-state.js';
import { env } from '../../src/config/env.js';

const at = new Date('2026-09-24T10:00:00Z');
const water = { relevance: 'UPDATE', status: 'INVESTIGATING', water_state: 'NO_SUPPLY', customer_supply: null,
  entities: [{ type: 'RESERVOIR', name: 'Alpha' }], localities: [], faults: [], confidence: 0.7,
  review_reason: 'Asset unclear', restoration_percent: null };

beforeEach(async () => { await resetDb(); });

it('the real quality and review queries see water-2 readings', async () => {
  await prisma.sourcePost.create({ data: { id: 'water-post', sourceAccount: 'JHBWater', serviceType: 'WATER',
    externalId: '700', text: 'Alpha reservoir has no supply', publishedAt: at, updatedAt: at, processingStatus: 'RELEVANT',
    processingStartedAt: new Date() } });
  await prisma.postExtraction.create({ data: { postId: 'water-post', promptVersion: 'water-2', model: 'test',
    status: 'SUCCEEDED', relevance: 'UPDATE', result: water } });
  const quality = await assessCycle({ prisma, faultItems, promptVersion: env.AI_PROMPT_VERSION,
    trigger: 'test', startedAt: new Date(Date.now() - 60_000) });
  expect(quality.status).toBe('NEEDS_REVIEW');
  expect(quality.summary.expectedFaults).toBe(1);
  expect(quality.problems).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'fault 0 has no disposition' })]));
  const review = await detectSuspicious({ prisma, postIds: ['water-post'] });
  expect(review[0].reasons.map((r) => r.code)).toContain('UNCERTAIN_READING');
});

it('undo recreates a typed water relation and its evidence', async () => {
  await prisma.sourcePost.create({ data: { id: 'p', sourceAccount: 'JHBWater', serviceType: 'WATER', externalId: '701',
    text: 'Alpha supplies Beta', publishedAt: at, updatedAt: at } });
  for (const [id, name, type] of [['parent', 'Alpha', 'RESERVOIR'], ['child', 'Beta', 'WATER_TOWER']]) {
    await prisma.infraNode.create({ data: { id, name, type, normalizedKey: name.toLowerCase(), serviceType: 'WATER', firstSeenAt: at, lastSeenAt: at } });
  }
  await prisma.infraEdge.create({ data: { parentId: 'parent', childId: 'child', relationType: 'SUPPLIES', lastSeenAt: at } });
  await prisma.evidenceContribution.create({ data: { postId: 'p', kind: 'EDGE', refA: 'parent', refB: 'SUPPLIES:child' } });
  const snapshot = await snapshotForPosts(prisma, ['p']);
  expect(snapshot.edges).toHaveLength(1);
  await prisma.evidenceContribution.deleteMany({ where: { postId: 'p' } });
  await prisma.infraEdge.delete({ where: { parentId_childId_relationType: { parentId: 'parent', childId: 'child', relationType: 'SUPPLIES' } } });
  await restoreSnapshot({ prisma, snapshot });
  expect(await prisma.infraEdge.findUnique({ where: { parentId_childId_relationType: { parentId: 'parent', childId: 'child', relationType: 'SUPPLIES' } } })).toMatchObject({ evidenceCount: 1 });
  expect(await prisma.evidenceContribution.count({ where: { postId: 'p', kind: 'EDGE' } })).toBe(1);
});

it('legacy split water effects keep each asset state despite a shared recovery headline', async () => {
  await prisma.sourcePost.create({ data: { id: 'p', sourceAccount: 'JHBWater', serviceType: 'WATER', externalId: '702',
    text: 'Recovery at Alpha and Beta', publishedAt: at, updatedAt: at } });
  const effects = [{ waterState: 'NORMAL', customerSupply: null }, { waterState: 'NO_SUPPLY', customerSupply: null }];
  for (const [i, effect] of effects.entries()) {
    await prisma.outage.create({ data: { id: `o${i}`, serviceType: 'WATER', title: `Asset ${i}`, status: 'ACTIVE', startedAt: at, lastUpdateAt: at } });
    await prisma.outagePost.create({ data: { outageId: `o${i}`, postId: 'p', faultIndex: i, role: 'OPENED', postedAt: at,
      effect: { status: 'INVESTIGATING', nodeIds: [], locs: [], headlineLocalities: [], ...effect } } });
  }
  await prisma.$transaction(async (tx) => {
    await refoldOutage(tx, 'o0');
    await refoldOutage(tx, 'o1');
  });
  expect(await prisma.outage.findUnique({ where: { id: 'o0' } })).toMatchObject({ status: 'RESTORED', waterState: 'NORMAL' });
  expect(await prisma.outage.findUnique({ where: { id: 'o1' } })).toMatchObject({ status: 'ACTIVE', waterState: 'NO_SUPPLY' });
});
