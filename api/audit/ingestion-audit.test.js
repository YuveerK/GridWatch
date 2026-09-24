// Regression tests for the fixes in docs/ENGINE_AUDIT_2026-09-23.md: PASS means the documented
// defect no longer reproduces. Disposable PostgreSQL only; X/AI/cache calls mocked. No application
// data changed.
import { beforeEach, expect, it, vi } from 'vitest';
const readings = new Map();
vi.mock('../src/modules/ai/extraction.service.js', async orig => ({
  ...(await orig()), extractPost: async id => {
    const p = await prisma.sourcePost.findUniqueOrThrow({ where: { id } });
    return structuredClone(readings.get(p.externalId));
  },
}));
vi.mock('../src/modules/ai/gemini.client.js', () => ({ generateJson: async () => { throw new Error('Unexpected AI call'); } }));
vi.mock('../src/modules/outages/tiebreak-cache.js', () => ({ cachedVerdict: () => undefined, storeVerdict: () => {} }));
import { prisma, resetDb } from '../tests/integration/db.js';
import { env } from '../src/config/env.js';
import { createCycle } from '../src/modules/processing/cycle.js';
import { ingestNewPosts } from '../src/modules/ingestion/ingestion.service.js';
import { processPost, processPending, reprocessPost, resetMunicipalityCache } from '../src/modules/processing/processor.service.js';
import { resetLocalityIndex } from '../src/modules/infrastructure/infrastructure.service.js';
import { snapshotForPosts, restoreSnapshot } from '../src/modules/processing/repair.js';
import { withLease, PIPELINE } from '../src/modules/coordination/lease.js';
import { setOverride } from '../src/modules/outages/overrides.js';
const T = Date.parse('2026-09-23T08:00:00Z');
const reading = (name = 'Alpha', status = 'INVESTIGATING') => ({ status: 'SUCCEEDED', relevance: status === 'RESTORED' ? 'RESTORATION' : 'OUTAGE', result: {
  relevance: status === 'RESTORED' ? 'RESTORATION' : 'OUTAGE', status, sdc: null, cause: null, eta_text: null, restoration_percent: null,
  entities: [{ type: 'SUBSTATION', name, parent_name: null }], localities: [{ name: 'Testville', state: status === 'RESTORED' ? 'RESTORED' : 'AFFECTED' }], faults: [], confidence: .95,
} });
async function post(id, minute, r = reading(), sourceAccount = 'CityPowerJhb') {
  readings.set(id, r);
  await prisma.sourcePost.create({ data: { id, externalId: id, sourceAccount, text: `${r.result.entities[0]?.name ?? 'Alpha'} outage`, publishedAt: new Date(T + minute * 60_000), updatedAt: new Date(T), conversationId: id } });
}
beforeEach(async () => { await resetDb(); resetLocalityIndex(); resetMunicipalityCache(); readings.clear(); });

it('a capped fetch holds the newer page back and processes the older incident first once the interval completes', async () => {
  readings.set('200', reading('Alpha', 'RESTORED')); readings.set('100', reading());
  const cycle = createCycle({
    ingest: args => ingestNewPosts({ ...args, maxPages: 1, fetchPage: async ({ paginationToken }) => {
      const n = paginationToken ? '100' : '200';
      return { posts: [{ tweet: { id: n, text: 'Alpha outage', created_at: new Date(T + (n === '200' ? 60_000 : 0)).toISOString() }, media: [] }], nextToken: paginationToken ? null : 'older' };
    } }),
    process: processPending, sweep: async () => ({}),
    counts: async () => ({ outages: await prisma.outage.count(), outagePosts: await prisma.outagePost.count() }),
  });
  await cycle.runNow();
  expect(cycle.status().result.fetchIncomplete).toBe(true);
  // post 200 (the restoration) was fetched but its account's interval isn't complete yet: held back, not processed out of order
  expect(cycle.status().result.processed).toBe(0);
  expect(cycle.status().result.held).toBe(1);
  expect(await prisma.outage.count()).toBe(0);
  expect((await prisma.sourcePost.findFirst({ where: { externalId: '200' } })).processingStatus).toBe('UNPROCESSED');
  await cycle.runNow();
  // the interval is now complete: both posts process oldest-first, so the restoration correctly folds onto the incident it opened
  expect(await prisma.outage.count()).toBe(1);
  expect((await prisma.outage.findFirst()).status).toBe('RESTORED');
});

it('one failed source does not prevent processing for another source that inserted posts successfully', async () => {
  const process = vi.fn(async () => ({ total: 0, attempted: 0, tally: {}, remaining: 0, held: 0 }));
  const cycle = createCycle({
    ingest: async () => ({ status: 'SUCCEEDED', postsInserted: 1, postsFetched: 2, failedAccounts: [{ displayName: 'CityTshwane', status: 'FAILED', error: 'second account unavailable' }] }),
    process, sweep: async () => ({}), counts: async () => ({ outages: 0, outagePosts: 0 }),
  });
  await cycle.runNow();
  expect(cycle.status().state).toBe('done');
  expect(process).toHaveBeenCalled();
  expect(cycle.status().result.incomplete).toContain('ingest:CityTshwane (failed)');
});

it('a source that fails entirely (every account) still stops the cycle rather than pretending to have processed', async () => {
  const process = vi.fn();
  const cycle = createCycle({ ingest: async () => ({ status: 'FAILED', error: 'every account unavailable', postsInserted: 0, postsFetched: 0 }), process, sweep: async () => ({}), counts: async () => ({ outages: 0, outagePosts: 0 }) });
  await cycle.runNow();
  expect(cycle.status().state).toBe('error');
  expect(process).not.toHaveBeenCalled();
});

it('processPending itself holds back an incomplete account, independent of cycle.js (scripts/process.js calls it directly)', async () => {
  const account = await prisma.sourceAccount.create({ data: { id: 'acct-1', platform: 'X', externalId: 'ext-1', displayName: 'CityPowerJhb', updatedAt: new Date() } });
  await prisma.ingestionState.create({ data: { accountId: account.externalId, incomplete: true } });
  await post('100', 0, reading(), 'CityPowerJhb');
  const held = await processPending();
  expect(held.attempted).toBe(0);
  expect(held.held).toBe(1);
  expect((await prisma.sourcePost.findUnique({ where: { id: '100' } })).processingStatus).toBe('UNPROCESSED');
  // --ignore-incomplete (scripts/process.js's explicit override) processes it anyway, even while still incomplete
  await post('200', 1, reading('Beta'), 'CityPowerJhb');
  const forced = await processPending({ ignoreIncomplete: true });
  expect(forced.attempted).toBe(2);
  expect((await prisma.sourcePost.findUnique({ where: { id: '100' } })).processingStatus).not.toBe('UNPROCESSED');
});

it('same-named equipment and locality from different municipalities never merge across source accounts', async () => {
  // resetDb() truncates SourceAccount but not Municipality/Region (static geography), so the seeded City of Johannesburg
  // row from migration 12_municipality is still there; Tshwane is created fresh here, same as scripts/seed-source-account.js would.
  const jhb = await prisma.municipality.findFirstOrThrow({ where: { code: 'JOHANNESBURG' } });
  const tshwane = await prisma.municipality.create({ data: { id: 'muni-tshwane-test', name: 'City of Tshwane', code: 'TSHWANE_TEST' } });
  await prisma.sourceAccount.create({ data: { id: 'acct-jhb', platform: 'X', externalId: 'ext-jhb', displayName: 'CityPowerJhb', municipalityId: jhb.id, updatedAt: new Date() } });
  await prisma.sourceAccount.create({ data: { id: 'acct-tshwane', platform: 'X', externalId: 'ext-tshwane', displayName: 'CityTshwane', municipalityId: tshwane.id, updatedAt: new Date() } });
  await post('100', 0, reading(), 'CityPowerJhb');
  await post('200', 1, reading(), 'CityTshwane');
  await processPost('100'); await processPost('200');
  // same name, same type, different municipalities: two distinct nodes, two distinct outages
  expect(await prisma.infraNode.count({ where: { type: 'SUBSTATION' } })).toBe(2);
  expect(await prisma.outage.count()).toBe(2);
  expect((await prisma.outagePost.findMany()).map((p) => p.postId).sort()).toEqual(['100', '200']);
  const outages = await prisma.outage.findMany({ orderBy: { createdAt: 'asc' } });
  expect(outages.map((o) => o.municipalityId).sort()).toEqual([jhb.id, tshwane.id].sort());
});

it('undo restores a changed accepted reading and effect even when membership and evidence identity are unchanged', async () => {
  await post('100', 0); await post('200', 1);
  await processPost('100'); await processPost('200');
  await prisma.postExtraction.create({ data: { postId: '200', promptVersion: env.AI_PROMPT_VERSION, model: 'mock', ...reading() } });
  const snapshot = await snapshotForPosts(prisma, ['200']);
  const changed = reading(); changed.result.cause = 'new incorrect cause';
  readings.set('200', changed);
  await prisma.postExtraction.update({ where: { postId_promptVersion: { postId: '200', promptVersion: env.AI_PROMPT_VERSION } }, data: { result: changed.result } });
  await reprocessPost('200');
  expect((await prisma.outage.findFirst()).cause).toBe('new incorrect cause');
  const out = await withLease(PIPELINE, ctx => restoreSnapshot({ prisma, snapshot, ctx }));
  expect(out.value.alreadyRestored).toBeFalsy();
  expect((await prisma.outage.findFirst()).cause).toBeNull();
  expect((await prisma.postExtraction.findFirst({ where: { postId: '200' } })).result.cause).toBeNull();
  // now that the content genuinely matches the snapshot again, a second undo is a true no-op
  const again = await withLease(PIPELINE, ctx => restoreSnapshot({ prisma, snapshot, ctx }));
  expect(again.value.alreadyRestored).toBe(true);
});

it('undo detects a summary-only change even when membership, evidence and reading are unchanged', async () => {
  await post('100', 0);
  await processPost('100');
  await prisma.postSummary.create({ data: { postId: '100', faultIndex: 0, summary: 'Original summary text here.', model: 'mock', promptVersion: env.AI_PROMPT_VERSION } });
  const snapshot = await snapshotForPosts(prisma, ['100']);
  await prisma.postSummary.update({ where: { postId_faultIndex: { postId: '100', faultIndex: 0 } }, data: { summary: 'A different, changed summary text.' } });
  const out = await withLease(PIPELINE, ctx => restoreSnapshot({ prisma, snapshot, ctx }));
  expect(out.value.alreadyRestored).toBeFalsy();
  expect((await prisma.postSummary.findFirst({ where: { postId: '100' } })).summary).toBe('Original summary text here.');
});

it('undo detects an override-only change even when membership, evidence and reading are unchanged', async () => {
  await post('100', 0); await post('200', 1);
  await processPost('100'); await processPost('200');
  const snapshot = await snapshotForPosts(prisma, ['200']);
  await setOverride({ postId: '200', faultIndex: 0, action: 'SPLIT', note: 'manual split for testing' });
  const out = await withLease(PIPELINE, ctx => restoreSnapshot({ prisma, snapshot, ctx }));
  expect(out.value.alreadyRestored).toBeFalsy();
  expect(await prisma.linkOverride.findUnique({ where: { postId_faultIndex: { postId: '200', faultIndex: 0 } } })).toBeNull();
});

it('moving the opening post leaves the remaining digest update to establish its own equipment and locality', async () => {
  await post('100', 0);
  const digest = reading(); digest.relevance = 'SDC_SUMMARY'; digest.result.relevance = 'SDC_SUMMARY';
  digest.result.faults = [{ status: 'INVESTIGATING', equipment: digest.result.entities, localities: digest.result.localities, cause: null, eta_text: null, restoration_percent: null }];
  await post('200', 1, digest);
  await processPost('100'); await processPost('200');
  const original = await prisma.outage.findFirst();
  const changed = reading('Beta'); changed.result.localities = [{ name: 'Elsewhere', state: 'AFFECTED' }];
  readings.set('100', changed);
  await reprocessPost('100');
  expect(await prisma.outagePost.count({ where: { outageId: original.id } })).toBe(1);
  // the remaining post is itself a separated fault (fromDigest), so it establishes its own scope on refold rather than being stranded
  expect(await prisma.outageNode.count({ where: { outageId: original.id } })).toBe(1);
  expect(await prisma.outageLocality.count({ where: { outageId: original.id } })).toBe(1);
});

it('a single genuine incident naming five independent components is treated as one outage, not a digest', async () => {
  const r = reading();
  r.result.entities = ['Alpha','Beta','Gamma','Delta','Epsilon'].map(name => ({ type: 'SUBSTATION', name, parent_name: null }));
  await post('100', 0, r);
  await processPost('100');
  expect(await prisma.outage.count()).toBe(1);
  expect((await prisma.linkDecision.findFirst()).outcome).toBe('NEW');
  expect((await prisma.sourcePost.findFirst()).processingStatus).toBe('RELEVANT');
  expect(await prisma.outageNode.count()).toBe(5);
});

it('a genuinely large digest graphic with no stated fault split needs review instead of a silent exclusion', async () => {
  const r = reading();
  r.result.entities = Array.from({ length: 12 }, (_, i) => ({ type: 'SUBSTATION', name: `Station${i}`, parent_name: null }));
  await post('100', 0, r);
  await processPost('100');
  expect(await prisma.outage.count()).toBe(0);
  expect((await prisma.linkDecision.findFirst()).outcome).toBe('NEEDS_REVIEW');
  expect((await prisma.sourcePost.findFirst()).processingStatus).toBe('NEEDS_REVIEW');
});

it('an already separated digest fault can add a newly affected suburb to an existing outage', async () => {
  await post('100', 0);
  const r = reading(); r.relevance = 'SDC_SUMMARY'; r.result.relevance = 'SDC_SUMMARY';
  r.result.faults = [{ status: 'INVESTIGATING', equipment: r.result.entities, localities: [...r.result.localities, { name: 'Newplace', state: 'AFFECTED' }], cause: null, eta_text: null, restoration_percent: null }];
  await post('200', 1, r);
  await processPost('100'); await processPost('200');
  expect(await prisma.outage.count()).toBe(1);
  const newplace = await prisma.locality.findFirst({ where: { canonicalName: 'Newplace' } });
  expect(newplace).not.toBeNull();
  expect(await prisma.outageLocality.count({ where: { localityId: newplace.id } })).toBe(1);
});
