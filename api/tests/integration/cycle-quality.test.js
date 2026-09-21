import { beforeEach, describe, expect, it, vi } from 'vitest';

// The "AI" reading of each post (by post id). No provider is ever called.
const readings = new Map();
vi.mock('../../src/modules/ai/extraction.service.js', async (orig) => ({
  ...(await orig()),
  extractPost: async (postId) => readings.get(postId) ?? { status: 'FAILED', result: null },
}));
vi.mock('../../src/modules/ai/gemini.client.js', () => ({
  generateJson: async ({ parts }) => {
    const first = JSON.parse(parts[0].text).candidate_outages[0];
    return { text: JSON.stringify({ outage_id: first.outage_id, reason: 'test verdict' }), inputTokens: 0, outputTokens: 0 };
  },
}));

const { createCycle, sweepStage } = await import('../../src/modules/processing/cycle.js');
const { assessCycle, beginCycleQuality, failCycleQuality, qualityStatus } = await import('../../src/modules/processing/quality.js');
const { reviewStage } = await import('../../src/modules/processing/cycle.js');
const { faultItems, processPending } = await import('../../src/modules/processing/processor.service.js');
const { withLease, PIPELINE } = await import('../../src/modules/coordination/lease.js');
const { resetLocalityIndex } = await import('../../src/modules/infrastructure/infrastructure.service.js');
const { env } = await import('../../src/config/env.js');
const { prisma, resetDb } = await import('./db.js');

const T0 = new Date('2026-09-21T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);
const base = { sdc: 'Test SDC', localities: [], faults: [], eta_text: null, cause: null, restoration_percent: null, update_summary: 'x', confidence: 0.9, image_text: null };
const reading = (relevance, status, equipment) => ({ status: 'SUCCEEDED', relevance, inputTokens: 0, outputTokens: 0, result: { ...base, relevance, status, entities: equipment.map((name) => ({ type: 'SUBSTATION', name, parent_name: null })) } });

let n = 0;
async function addPost(min, text, r) {
  n += 1;
  const id = `q${n}`;
  await prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: String(6000 + n), text, publishedAt: at(min), updatedAt: at(min), conversationId: String(6000 + n) } });
  readings.set(id, r);
  // the stored reading the assessment compares against (what the real extractor writes)
  await prisma.postExtraction.create({ data: { postId: id, promptVersion: env.AI_PROMPT_VERSION, model: 'm', status: 'SUCCEEDED', relevance: r.relevance, result: r.result } });
  return id;
}

const assess = (args) => assessCycle({ prisma, faultItems, promptVersion: env.AI_PROMPT_VERSION, ...args });
/** A cycle whose fetch "inserts" the given posts (recording them against a run, as the real fetch does). */
const cycleWith = (ids, overrides = {}) =>
  createCycle({
    lease: (fn) => withLease(PIPELINE, fn),
    sweep: sweepStage,
    counts: async () => ({ outages: await prisma.outage.count(), outagePosts: await prisma.outagePost.count() }),
    ingest: async () => {
      const run = await prisma.ingestionRun.create({ data: { id: `run-${Date.now()}`, sourceAccountId: 'acct', postsFetched: ids.length, postsInserted: ids.length, status: 'SUCCEEDED' } });
      for (const postId of ids) await prisma.ingestionRunPost.create({ data: { ingestionRunId: run.id, postId } });
      return { status: 'SUCCEEDED', postsFetched: ids.length, postsInserted: ids.length, runId: run.id };
    },
    process: processPending,
    assess,
    begin: ({ trigger, startedAt }) => beginCycleQuality({ prisma, trigger, startedAt }),
    failRecord: (args) => failCycleQuality({ prisma, ...args }),
    ...overrides,
  });

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EvidenceContribution", "Locality", "WorkLease", "CycleQuality", "IngestionRun", "SourceAccount" CASCADE');
  await prisma.sourceAccount.create({ data: { id: 'acct', platform: 'X', externalId: 'acct', displayName: 'Test', updatedAt: new Date() } });
  resetLocalityIndex();
  readings.clear();
  n = 0;
});

describe('B1/B2: each cycle saves what it covered and whether it completed', () => {
  it('a clean cycle is COMPLETE and lists exactly its posts, faults, dispositions and outages', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(30, 'Alpha crew on site', reading('UPDATE', 'CREW_ON_SITE', ['Alpha']));
    const cycle = cycleWith([a, b]);
    await cycle.runNow('manual');
    const row = await prisma.cycleQuality.findFirst();
    expect(row.status).toBe('COMPLETE');
    expect(row.summary).toMatchObject({ posts: 2, expectedFaults: 2, faultsWithDisposition: 2, outagesChanged: 1, problems: 0, needsReview: 0, backlog: 0 });
    expect(row.posts.map((p) => p.postId)).toEqual([a, b]);
    expect(row.posts[0].faults).toEqual([expect.objectContaining({ faultIndex: 0, outcome: 'NEW' })]);
    expect(row.posts[1].faults[0].outcome).toBe('LINKED');
    expect(row.posts[0].revision).toMatch(/^[0-9a-f]{16}$/);
    expect(cycle.status().result.quality).toMatchObject({ status: 'COMPLETE', problems: 0 });
  });

  it('a fault with no disposition is caught, and the cycle is NEEDS_REVIEW, not COMPLETE', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const startedAt = new Date(Date.now() - 60_000);
    await processPending();
    await prisma.linkDecision.deleteMany({ where: { postId: a } }); // the defect: a fault silently lost its outcome
    const r = await assess({ trigger: 'manual', startedAt });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.problems).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'DISPOSITION', message: 'fault 0 has no disposition' })]));
  });

  it('an outage entry built from a different reading than the current one is caught', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const startedAt = new Date(Date.now() - 60_000);
    await processPending();
    await prisma.postExtraction.updateMany({ where: { postId: a }, data: { result: { ...readings.get(a).result, status: 'REPAIRING' } } }); // re-read changed the status; nothing re-linked
    const r = await assess({ trigger: 'manual', startedAt });
    expect(r.problems.map((p) => p.kind)).toContain('STALE_EFFECT');
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('missing work is INCOMPLETE: a skipped stage, a backlog, an unfinished fetch', async () => {
    const startedAt = new Date(Date.now() - 60_000);
    expect((await assess({ trigger: 'scheduler', startedAt, incomplete: ['sweep'] })).status).toBe('INCOMPLETE');
    expect((await assess({ trigger: 'scheduler', startedAt, backlog: 12 })).status).toBe('INCOMPLETE');
    expect((await assess({ trigger: 'scheduler', startedAt, ingestion: { incomplete: true } })).status).toBe('INCOMPLETE');
  });

  it('a cycle that throws is recorded as FAILED', async () => {
    const cycle = createCycle({
      lease: (fn) => withLease(PIPELINE, fn),
      sweep: sweepStage,
      counts: async () => ({ outages: 0, outagePosts: 0 }),
      ingest: async () => ({ status: 'FAILED', error: "Couldn't reach X." }),
      process: async () => ({}),
      assess,
    });
    await cycle.runNow('scheduler');
    const row = await prisma.cycleQuality.findFirst();
    expect(row.status).toBe('FAILED');
    expect(row.summary.error).toMatch(/reach X/);
  });

  it('a failed assessment is an explicit outcome: the record is FAILED and the result says so', async () => {
    const cycle = cycleWith([], { assess: async () => { throw new Error('assessment down'); } });
    await cycle.runNow('manual');
    const result = cycle.status().result;
    expect(cycle.status().state).toBe('done');
    expect(result.degraded).toBe(true);
    expect(result.stageFailures).toContain('assess');
    expect(result.quality).toMatchObject({ status: 'FAILED', error: 'assessment down' });
    const row = await prisma.cycleQuality.findFirst();
    expect(row.status).toBe('FAILED');
    expect(row.summary).toMatchObject({ failedStage: 'assess' });
  });

  it('the cycle record exists from the start (RUNNING) and is completed in place', async () => {
    let during;
    const cycle = cycleWith([], { process: async () => { during = await prisma.cycleQuality.findMany(); return {}; } });
    await cycle.runNow('manual');
    expect(during).toHaveLength(1);
    expect(during[0].status).toBe('RUNNING');
    const rows = await prisma.cycleQuality.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(during[0].id);
    expect(rows[0].status).toBe('COMPLETE');
  });

  it('a failed review pass makes the cycle INCOMPLETE, and its posts are looked at again next cycle', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const cycle = cycleWith([a], { review: async () => { throw new Error('review down'); } });
    await cycle.runNow('manual');
    expect(cycle.status().result.stageFailures).toEqual(['review']);
    const row = await prisma.cycleQuality.findFirst();
    expect(row.status).toBe('INCOMPLETE');
    expect(row.summary.incomplete).toContain('review');
    // next cycle covers nothing new, yet the earlier posts are reviewed and the old record is marked as retried
    await reviewStage({ startedAt: new Date(), ingestionRunId: null }, prisma);
    const after = await prisma.cycleQuality.findUnique({ where: { id: row.id } });
    expect(after.summary.reviewRetriedAt).toBeTruthy();
  });

  it('an open real review item of a covered post makes the cycle NEEDS_REVIEW; a routine spot-check does not', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const startedAt = new Date(Date.now() - 60_000);
    await processPending();
    await prisma.reviewItem.create({ data: { postId: a, faultIndex: 0, priority: 1, sampled: true, reasons: [{ code: 'SAMPLE' }] } });
    const routine = await assess({ trigger: 'manual', startedAt });
    expect(routine.status).toBe('COMPLETE');
    expect(routine.summary).toMatchObject({ reviewOpen: 0, reviewSampled: 1 });
    await prisma.reviewItem.update({ where: { postId_faultIndex: { postId: a, faultIndex: 0 } }, data: { sampled: false, priority: 10, reasons: [{ code: 'KIND_CONFLICT' }] } });
    const real = await assess({ trigger: 'manual', startedAt });
    expect(real.status).toBe('NEEDS_REVIEW');
    expect(real.summary.reviewOpen).toBe(1);
  });

  it('the public status shows how old the result is, a running or stuck cycle, and open concerns', async () => {
    const now = new Date('2026-09-22T12:00:00Z');
    expect((await qualityStatus(prisma, { now })).status).toBe('UNKNOWN');
    const mk = (status, minsAgo, extra = {}) => prisma.cycleQuality.create({ data: { trigger: 'scheduler', status, startedAt: new Date(+now - (minsAgo + 1) * 60_000), finishedAt: new Date(+now - minsAgo * 60_000), summary: {}, problems: [], posts: [], changedOutageIds: [], ...extra } });
    await mk('COMPLETE', 10);
    expect(await qualityStatus(prisma, { now })).toMatchObject({ status: 'COMPLETE', lastCycle: { ageMinutes: 10 }, currentCycle: null });
    await prisma.cycleQuality.deleteMany();
    await mk('COMPLETE', 400);
    expect((await qualityStatus(prisma, { now })).status).toBe('STALE'); // an old clean result is not a current one
    await prisma.cycleQuality.deleteMany();
    await mk('COMPLETE', 100);
    await mk('RUNNING', 0, { startedAt: new Date(+now - 90 * 60_000), finishedAt: new Date(+now - 90 * 60_000) });
    const s = await qualityStatus(prisma, { now });
    expect(s.currentCycle).toMatchObject({ stuck: true });
    expect(s.status).toBe('STALE');
  });
});
