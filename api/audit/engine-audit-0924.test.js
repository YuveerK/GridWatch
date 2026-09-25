// Regression cases converted from the audit reproductions: PASS means the fix holds.
// No real database, X, Gemini, filesystem cache, or application server is used.
import { beforeEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => Object.fromEntries([
  'sourceAccount', 'sourcePost', 'ingestionState', 'ingestionRun', 'ingestionRunPost',
  'outage', 'outagePost', 'outageNode', 'outageLocality', 'reviewItem', 'cycleQuality', 'infraNode',
  'evidenceContribution', 'infraEdge', 'nodeLocality', 'postExtraction', 'postSummary', 'linkOverride', 'linkDecision',
].map(name => [name, Object.fromEntries(['findFirst', 'findUnique', 'findMany', 'count', 'create', 'createMany', 'upsert', 'update', 'updateMany', 'deleteMany'].map(method => [method, vi.fn()]))])));
vi.mock('../src/db/prisma.js', () => ({ prisma: db }));
vi.mock('../src/modules/coordination/lease.js', () => ({
  PIPELINE: 'pipeline', LeaseLostError: class extends Error {},
  assertLeaseInTx: async () => {}, recoverStaleWork: async () => {},
  exclusive: async (_ctx, fn) => ({ acquired: true, value: await fn({ assertHeld() {} }) }),
  withLease: async (_name, fn) => ({ acquired: true, value: await fn({ assertHeld() {} }) }),
}));
vi.mock('../src/modules/ai/gemini.client.js', () => ({ generateJson: async () => { throw new Error('Unexpected AI request'); } }));

import { backfillAccount, ingestNewPosts } from '../src/modules/ingestion/ingestion.service.js';
import { processPending, faultItems } from '../src/modules/processing/processor.service.js';
import { assessCycle, effectReadingMismatch, readingFaultItems } from '../src/modules/processing/quality.js';
import { detectSuspicious } from '../src/modules/review/review.service.js';
import { waterReader, waterFaultItems } from '../src/modules/ai/readers/water.reader.js';
import { readingRevision } from '../src/lib/reading-revision.js';
import { foldEffects, refoldOutage } from '../src/modules/outages/outage-state.js';
import { env } from '../src/config/env.js';
import { snapshotForPosts, restoreSnapshot } from '../src/modules/processing/repair.js';

const account = { id: 'water', externalId: '999', displayName: 'JHBWater', serviceType: 'WATER', active: true };
const from = new Date('2026-09-01T00:00:00Z');
const to = new Date('2026-09-20T00:00:00Z');
const page = (ids, nextToken = null) => ({ posts: ids.map(id => ({ tweet: { id, text: 'water update', created_at: '2026-09-15T00:00:00Z' }, media: [] })), nextToken });
let state, stored, runs;
beforeEach(() => {
  vi.resetAllMocks();
  state = null; stored = new Map(); runs = [];
  db.$transaction = async fn => fn(db);
  db.sourceAccount.findFirst.mockResolvedValue(account);
  db.sourceAccount.count.mockResolvedValue(1);
  db.sourceAccount.findMany.mockResolvedValue([account]);
  db.ingestionState.findUnique.mockImplementation(async () => state);
  db.ingestionState.upsert.mockImplementation(async ({ create, update }) => (state = state ? { ...state, ...update } : create));
  db.ingestionRun.create.mockImplementation(async ({ data }) => { const run = { ...data }; runs.push(run); return run; });
  db.ingestionRun.findFirst.mockImplementation(async ({ where }) => [...runs].reverse().find(r => r.sourceAccountId === where.sourceAccountId
    && where.AND.every(c => Object.entries(c.diagnostics).every(([key, value]) => key === 'path' || r.diagnostics?.[c.diagnostics.path[0]] === value))) ?? null);
  db.ingestionRun.update.mockImplementation(async ({ where, data }) => { const run = runs.find(r => r.id === where.id); Object.assign(run, data); return run; });
  db.ingestionRun.findMany.mockResolvedValue([]);
  db.sourcePost.findMany.mockImplementation(async () => [...stored.values()]);
  db.sourcePost.create.mockImplementation(async ({ data }) => { stored.set(data.externalId, data); return data; });
});

it('stores all posts on a final page that crosses the soft ceiling', async () => {
  const result = await backfillAccount({ handle: account.displayName, from, to, maxPosts: 1, fetchPage: async () => page(['300', '200', '100']) });
  expect([...stored.keys()]).toEqual(['300', '200', '100']);
  expect(result).toMatchObject({ complete: true, ceiling: false });
  expect(state).toMatchObject({ completedHighWater: '300', incomplete: false, cursorToken: null });
  const live = vi.fn(async () => page([]));
  await ingestNewPosts({ fetchPage: live });
  expect(live.mock.calls[0][0].sinceId).toBe('300');
});

it('resumes at the next page after crossing the soft ceiling', async () => {
  const fetchPage = vi.fn(async ({ paginationToken }) => paginationToken ? page(['50']) : page(['300', '200', '100'], 'older'));
  await backfillAccount({ handle: account.displayName, from, to, maxPosts: 1, fetchPage });
  const again = await backfillAccount({ handle: account.displayName, from, to, maxPosts: 1, fetchPage });
  expect(again).toMatchObject({ complete: true, ceiling: false, postsInserted: 1, postsDeduplicated: 0, resumed: true });
  expect([...stored.keys()]).toEqual(['300', '200', '100', '50']);
  expect(fetchPage.mock.calls.map(([args]) => args.paginationToken)).toEqual([null, 'older']);
});

it('a disjoint historical window leaves the live mark at the last continuous position', async () => {
  state = { accountId: '999', completedHighWater: '100', incomplete: false };
  await backfillAccount({ handle: account.displayName, from, to, fetchPage: async () => page(['300']) });
  const live = vi.fn(async () => page([]));
  await ingestNewPosts({ fetchPage: live });
  expect(live.mock.calls[0][0].sinceId).toBe('100');
});

it('a changed end date starts a separate historical window', async () => {
  await backfillAccount({ handle: account.displayName, from, to, maxPosts: 1, fetchPage: async () => page(['300'], 'old-window-cursor') });
  const fetchPage = vi.fn(async () => page([]));
  const nextTo = new Date('2026-09-24T00:00:00Z');
  const result = await backfillAccount({ handle: account.displayName, from, to: nextTo, fetchPage });
  expect(result.resumed).toBe(false);
  expect(fetchPage.mock.calls[0][0]).toMatchObject({ endTime: nextTo, paginationToken: null });
});

it('an incomplete account is excluded without changing the requested processing source', async () => {
  db.ingestionState.findMany.mockResolvedValue([{ accountId: 'other' }]);
  db.sourceAccount.findMany.mockResolvedValue([{ displayName: 'OtherWater' }]);
  db.sourcePost.findMany.mockResolvedValue([]);
  db.sourcePost.count.mockResolvedValue(0);
  await processPending({ sourceAccount: 'JHBWater', serviceType: 'WATER' });
  expect(db.sourcePost.findMany.mock.calls[0][0].where.AND).toEqual([
    expect.objectContaining({ sourceAccount: 'JHBWater' }), { sourceAccount: { notIn: ['OtherWater'] } },
  ]);
  expect(db.sourcePost.count.mock.calls[1][0].where.AND).toEqual([
    expect.objectContaining({ sourceAccount: 'JHBWater' }), { sourceAccount: { in: ['OtherWater'] } },
  ]);
});

const waterReading = () => waterReader.normaliseReading({
  relevance: 'SYSTEM_UPDATE', kind: 'UNPLANNED', water_state: 'NO_SUPPLY', customer_supply: null,
  cause: null, eta_text: null, restoration_percent: null, systems: [],
  entities: [{ type: 'RESERVOIR', name: 'Alpha' }],
  localities: [{ name: 'Alpha suburb', impact: 'AFFECTED' }], faults: [], confidence: 0.65,
  review_reason: 'Asset identification uncertain', image_text: '',
});

it('quality checks a water reading and rejects a missing disposition', async () => {
  const extraction = { promptVersion: waterReader.promptVersion, status: 'SUCCEEDED', result: waterReading() };
  db.sourcePost.findMany.mockImplementation(async ({ select }) => {
    if (select.id && !select.extractions) return [{ id: 'p' }];
    if (!select.extractions) return [];
    return [{ id: 'p', externalId: '1', processingStatus: 'RELEVANT', text: 'Alpha water update',
      serviceType: 'WATER', extractions: [extraction], linkDecisions: [], outagePosts: [] }];
  });
  db.outage.findMany.mockResolvedValue([]);
  db.reviewItem.findMany.mockResolvedValue([]);
  db.cycleQuality.create.mockImplementation(async ({ data }) => ({ id: 'quality', ...data }));
  const out = await assessCycle({ prisma: db, faultItems, promptVersion: env.AI_PROMPT_VERSION, startedAt: from, trigger: 'audit' });
  expect(out.status).toBe('NEEDS_REVIEW');
  expect(out.summary.expectedFaults).toBe(1);
  expect(out.problems.some(p => p.message.includes('no disposition'))).toBe(true);
});

it('review sees uncertainty in an accepted water incident reading', async () => {
  const extraction = { promptVersion: waterReader.promptVersion, status: 'SUCCEEDED', result: waterReading() };
  db.sourcePost.findMany.mockImplementation(async ({ select }) => [{ id: 'p', serviceType: 'WATER',
    processingStatus: 'RELEVANT', text: 'Alpha reservoir update', retries: [], linkDecisions: [], outagePosts: [],
    extractions: [extraction] }]);
  db.infraNode.findMany.mockResolvedValue([]);
  expect(await detectSuspicious({ prisma: db, postIds: ['p'] })).toEqual([
    expect.objectContaining({ postId: 'p', reasons: expect.arrayContaining([expect.objectContaining({ code: 'UNCERTAIN_READING' })]) }),
  ]);
});

it('water fault validation uses the water fault splitter', () => {
  const result = waterReading();
  result.faults = [{ entities: [], localities: [], water_state: 'EMPTY' }, { entities: [], localities: [], water_state: 'RECOVERING' }];
  expect(readingFaultItems({ serviceType: 'WATER' }, { status: 'SUCCEEDED', relevance: result.relevance, result }, faultItems)).toHaveLength(2);
});

it('the reading revision detects changed water conditions and per-fault assets', () => {
  const before = waterReading();
  before.faults = [{ entities: [{ type: 'RESERVOIR', name: 'Alpha' }], localities: [], water_state: 'EMPTY' }];
  const after = structuredClone(before);
  after.water_state = 'RECOVERING';
  after.faults[0].water_state = 'RECOVERING';
  after.faults[0].entities[0].name = 'Beta';
  expect(readingRevision(after)).not.toBe(readingRevision(before));
  expect(effectReadingMismatch({ reading: readingRevision(before) }, after)).toBe(true);
});

it('recovery of one asset does not overwrite another fault with NO_SUPPLY', async () => {
  const at = new Date('2026-09-15T00:00:00Z');
  db.outage.findUnique.mockResolvedValue({ status: 'ACTIVE', kind: 'UNPLANNED', lastUpdateAt: at });
  db.outagePost.findMany.mockResolvedValue([{ postId: 'p', faultIndex: 1, postedAt: at,
    post: { serviceType: 'WATER', text: 'Alpha pumping has resumed. Beta has no supply.' },
    effect: { waterState: 'NO_SUPPLY', customerSupply: null, splitFault: true, status: 'INVESTIGATING', nodeIds: [], locs: [] } }]);
  await refoldOutage(db, 'beta');
  expect(db.outage.update.mock.calls[0][0].data.waterState).toBe('NO_SUPPLY');
});

it('a water outage that loses supply after restoration clears its old 100 percent restoration', () => {
  const effect = (waterState, customerSupply) => ({ waterState, customerSupply, pct: null, locs: [], nodeIds: [] });
  const out = foldEffects([
    { postId: '1', postedAt: from, effect: effect('NORMAL', 'RESTORED') },
    { postId: '2', postedAt: to, effect: effect('NO_SUPPLY', null) },
  ]);
  expect(out).toMatchObject({ status: 'ACTIVE', waterState: 'NO_SUPPLY', restorationPercent: null, restoredAt: null });
});

it('snapshot includes a typed water edge using its decoded child id', async () => {
  for (const model of Object.values(db)) if (model.findMany) model.findMany.mockResolvedValue([]);
  db.evidenceContribution.findMany.mockResolvedValue([{ postId: 'p', faultIndex: 0, kind: 'EDGE', refA: 'parent', refB: 'SUPPLIES:child' }]);
  db.infraEdge.findMany.mockImplementation(async ({ where }) => where.OR.some(k => k.childId === 'child')
    ? [{ parentId: 'parent', childId: 'child', relationType: 'SUPPLIES', evidenceCount: 1 }] : []);
  const snapshot = await snapshotForPosts(db, ['p']);
  expect(db.infraEdge.findMany.mock.calls[0][0].where.OR).toEqual([{ parentId: 'parent', childId: 'child', relationType: 'SUPPLIES' }]);
  expect(snapshot.edges).toEqual([{ parentId: 'parent', childId: 'child', relationType: 'SUPPLIES', evidenceCount: 1 }]);
});

it('undo restores the typed edge and its contribution together', async () => {
  for (const model of Object.values(db)) if (model.findMany) model.findMany.mockResolvedValue([]);
  db.infraEdge.findUnique.mockResolvedValue(null);
  const evidence = [{ postId: 'p', faultIndex: 0, kind: 'EDGE', refA: 'parent', refB: 'SUPPLIES:child' }];
  const snapshot = { version: 1, postIds: ['p'], posts: [], outagePosts: [], outages: [], linkDecisions: [], evidence,
    nodes: [], edges: [{ parentId: 'parent', childId: 'child', relationType: 'SUPPLIES', evidenceCount: 1 }], nodeLocalities: [], extractions: [], summaries: [], overrides: [] };
  await restoreSnapshot({ prisma: db, snapshot });
  expect(db.infraEdge.findUnique.mock.calls[0][0].where).toEqual({ parentId_childId_relationType: {
    parentId: 'parent', childId: 'child', relationType: 'SUPPLIES',
  } });
  expect(db.infraEdge.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: 'parent', childId: 'child', relationType: 'SUPPLIES' }) }));
  expect(db.evidenceContribution.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining(evidence[0])]) }));
});
