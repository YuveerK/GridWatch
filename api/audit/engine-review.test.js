// Characterization tests: passing means the defect is reproduced, not that the behavior is correct.
// Run from api: npx vitest run --config audit/engine-review.config.js
// All database and AI calls are mocked; no real posts, services, or caches are changed.
import { beforeEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(), $transaction: vi.fn(),
  outage: { findMany: vi.fn(), updateMany: vi.fn() },
  infraEdge: { findMany: vi.fn() }, locality: { findMany: vi.fn() },
  linkDecision: { findUnique: vi.fn(), create: vi.fn() },
  infraNode: { findUnique: vi.fn(), update: vi.fn() },
  evidenceContribution: { createMany: vi.fn() },
  postExtraction: { findUnique: vi.fn(), upsert: vi.fn() },
  sourcePost: { findUniqueOrThrow: vi.fn() },
  postSummary: { deleteMany: vi.fn(), create: vi.fn() },
}));
const ai = vi.hoisted(() => vi.fn());
vi.mock('../src/db/prisma.js', () => ({ prisma: db }));
vi.mock('../src/modules/ai/gemini.client.js', () => ({ generateJson: ai }));
vi.mock('../src/modules/outages/overrides.js', () => ({ resolveOverride: async () => null }));
vi.mock('../src/modules/infrastructure/knowledge-context.js', () => ({ knowledgeContext: async () => null, sdcFromText: () => null }));

import { createCycle } from '../src/modules/processing/cycle.js';
import { linkPost, sweepStaleOutages } from '../src/modules/outages/linker.service.js';
import { markRestoredPlaces } from '../src/lib/restored-places.js';
import { foldEffects, statusFor } from '../src/modules/outages/outage-state.js';
import { extractPost, mediaUrl } from '../src/modules/ai/extraction.service.js';
import { resolveNode } from '../src/modules/infrastructure/infrastructure.service.js';

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (fn) => fn(db));
});

it('refresh reports done while the real sweep tries to acquire its already-held lease and skips', async () => {
  db.$queryRawUnsafe.mockResolvedValue([]); // pipeline is already held by this cycle
  const cycle = createCycle({
    lease: async (fn) => ({ acquired: true, value: await fn({ name: 'pipeline', owner: 'cycle-owner' }) }),
    counts: async () => ({ outages: 1, outagePosts: 1 }),
    ingest: async () => ({ status: 'SUCCEEDED' }),
    process: async () => ({ total: 0 }),
    sweep: sweepStaleOutages,
  });
  await cycle.runNow();
  expect(cycle.status().state).toBe('done');
  expect(db.$queryRawUnsafe).toHaveBeenCalled();
  expect(db.outage.updateMany).not.toHaveBeenCalled();
});

it.each([
  'Power will be restored to Alpha by 23h00.',
  'Power cannot be restored to Alpha until repairs are complete.',
])('restoration override mistakes an unfulfilled promise for a completed restoration: %s', (text) => {
  const result = markRestoredPlaces({ status: 'REPAIRING', restoration_percent: null, localities: [{ name: 'Alpha', state: 'AFFECTED' }] }, text);
  expect(result.localities[0].state).toBe('RESTORED');
  expect(statusFor({ result }, 'ACTIVE')).toBe('RESTORED');
});

it('an overall partial percentage erases explicit restoration of an individual suburb', () => {
  const folded = foldEffects([{
    postId: 'p', postedAt: new Date(), faultIndex: 0,
    effect: { status: 'PARTIALLY_RESTORED', pct: 40, expand: true,
      headlineLocalities: [{ state: 'RESTORED' }, { state: 'AFFECTED' }],
      locs: [{ id: 'Alpha', restored: true }, { id: 'Beta', restored: false }], nodeIds: [] },
  }]);
  expect(folded.status).toBe('PARTIALLY_RESTORED');
  expect(folded.localities.get('Alpha')).toBe(false);
});

it('one already-split fault with four nodes and two roots is silently discarded as a digest', async () => {
  db.linkDecision.findUnique.mockResolvedValue(null);
  db.linkDecision.create.mockImplementation(async ({ data }) => data);
  db.infraEdge.findMany.mockResolvedValue([]);
  db.locality.findMany.mockResolvedValue([]);
  db.outage.findMany.mockResolvedValue([]);
  const result = await linkPost({
    postRow: { id: 'p', publishedAt: new Date(), text: 'Outage update', externalId: '1' },
    extraction: { relevance: 'OUTAGE', result: { status: 'INVESTIGATING', entities: [], localities: [], faults: [] } },
    facts: { fromDigest: true, rootCount: 2, nodes: ['a','b','c','d'].map((id) => ({ id, name: id, normalizedKey: id })), localityIds: [], restoredLocalityIds: [] },
  });
  expect(result.outcome).toBe('NEW');
  expect(result.reason).toContain('no outage created');
  expect(result.outageId).toBeUndefined();
});

it('media host validation accepts an unrelated domain ending in twimg.com', () => {
  expect(mediaUrl('https://not-twimg.com/image.jpg')).toBe('https://not-twimg.com/image.jpg?name=large');
});

it('a node counter write failure leaves its contribution committed, so retry loses evidence', async () => {
  const at = new Date();
  const node = { id: 'n', type: 'SUBSTATION', normalizedKey: 'alpha', evidenceCount: 1, lifecycle: 'CANDIDATE', firstSeenAt: at, lastSeenAt: at };
  db.infraNode.findUnique.mockResolvedValue(node);
  db.evidenceContribution.createMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
  db.infraNode.update.mockRejectedValueOnce(new Error('counter write failed')).mockImplementation(async ({ data }) => ({ ...node, ...data }));
  const args = { type: 'SUBSTATION', name: 'Alpha', at, source: { postId: 'p', faultIndex: 0 } };
  await expect(resolveNode(args)).rejects.toThrow('counter write failed');
  const retried = await resolveNode(args);
  expect(retried.evidenceCount).toBe(1);
  expect(retried.lifecycle).toBe('CANDIDATE');
});

it('a low-confidence forced reread overwrites a previously successful reading', async () => {
  const result = { relevance: 'OUTAGE', sdc: null, status: 'INVESTIGATING', cause: null, eta_text: null,
    restoration_percent: null, entities: [], localities: [], faults: [], update_summary: 'Uncertain outage',
    image_text: null, confidence: 0.2, review_reason: 'Unclear' };
  db.postExtraction.findUnique.mockResolvedValue({ id: 'old', status: 'SUCCEEDED', result: { ...result, confidence: 0.9 } });
  db.sourcePost.findUniqueOrThrow.mockResolvedValue({ text: 'Outage', publishedAt: new Date(), PostMedia: [] });
  ai.mockResolvedValue({ text: JSON.stringify(result) });
  db.postExtraction.upsert.mockImplementation(async ({ update }) => update);
  const reread = await extractPost('p', { force: true });
  expect(reread.status).toBe('NEEDS_REVIEW');
  expect(db.postExtraction.upsert).toHaveBeenCalled();
  expect(db.postSummary.deleteMany).toHaveBeenCalled();
});
