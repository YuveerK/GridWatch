import { beforeEach, describe, expect, it } from 'vitest';

process.env.VERIFIER_ENABLED = 'on'; // this file exercises the verifier (the default is off)
process.env.VERIFIER_MAX_CALLS_PER_DAY = '30';
process.env.VERIFIER_SAMPLE_RATE = '1';

const { detectSuspicious, listReviewItems, resolveReviewItem, runReview, saveReviewItems } = await import('../../src/modules/review/review.service.js');
const { callsLeftToday, verifyItem } = await import('../../src/modules/review/verifier.js');
const { env } = await import('../../src/config/env.js');
const { prisma, resetDb } = await import('./db.js');

const T = new Date('2026-09-21T10:00:00Z');
const at = (h) => new Date(T.getTime() + h * 3_600_000);
let n = 0;

const result = (over = {}) => ({ relevance: 'OUTAGE', status: 'INVESTIGATING', sdc: 'S', cause: null, eta_text: null, restoration_percent: null, entities: [], localities: [], faults: [], update_summary: 'x', image_text: null, confidence: 0.9, review_reason: null, ...over });

/** A post with a stored reading, and (optionally) the outage it opened or joined. */
async function post({ text = 'Power out', h = 0, relevance = 'OUTAGE', readingOver = {}, status = 'RELEVANT' } = {}) {
  n += 1;
  const id = `r${n}`;
  await prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: String(4000 + n), text, publishedAt: at(h), updatedAt: at(h), processingStatus: status } });
  await prisma.postExtraction.create({ data: { postId: id, promptVersion: env.AI_PROMPT_VERSION, model: 'm', status: 'SUCCEEDED', relevance, result: result({ relevance, ...readingOver }), imageText: null } });
  return id;
}
async function outage({ title, kind = 'UNPLANNED', status = 'ACTIVE', h = 0, retroactive = false, localityIds = [], nodes = [] }) {
  const o = await prisma.outage.create({ data: { title, kind, status, startedAt: at(h), lastUpdateAt: at(h), retroactive } });
  for (const localityId of localityIds) await prisma.outageLocality.create({ data: { outageId: o.id, localityId } });
  for (const nodeId of nodes) await prisma.outageNode.create({ data: { outageId: o.id, nodeId } });
  return o;
}
const join = (outageId, postId, { role = 'OPENED', faultIndex = 0, h = 0, effect = { status: 'INVESTIGATING', locs: [] } } = {}) =>
  prisma.outagePost.create({ data: { outageId, postId, role, faultIndex, postedAt: at(h), effect } });
const decide = (postId, outcome, outageId, reason = 'test', faultIndex = 0) => prisma.linkDecision.create({ data: { postId, faultIndex, outcome, outageId, reason } });
const reasonsOf = async (postIds) => Object.fromEntries((await detectSuspicious({ prisma, postIds })).map((s) => [`${s.postId}:${s.faultIndex}`, s.reasons.map((r) => r.code)]));

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EvidenceContribution", "Locality" CASCADE');
  n = 0;
  const now = new Date();
  await prisma.locality.createMany({ data: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].map((id) => ({ id, canonicalName: id, normalizedName: id, updatedAt: now })) });
});

describe('B4: what is flagged, and what is not', () => {
  it('nothing for an ordinary post that joined its outage', async () => {
    const o = await outage({ title: 'Fort', localityIds: ['l1'] });
    const a = await post();
    const b = await post({ h: 1, relevance: 'UPDATE' });
    await join(o.id, a);
    await join(o.id, b, { role: 'UPDATE', h: 1 });
    await decide(a, 'NEW', o.id);
    await decide(b, 'LINKED', o.id);
    expect(await reasonsOf([a, b])).toEqual({});
  });

  it('a new outage opened next to a similar live one', async () => {
    const first = await outage({ title: 'Fort (Hillbrow)', localityIds: ['l1'], h: -2 });
    const p = await post({ h: -2 });
    await join(first.id, p, { h: -2 });
    const dup = await outage({ title: 'Hillbrow', localityIds: ['l1'] });
    const q = await post();
    await join(dup.id, q);
    await decide(q, 'NEW', dup.id);
    expect(await reasonsOf([q])).toEqual({ [`${q}:0`]: ['NEW_NEAR_ACTIVE'] });
  });

  it('a restoration that opened its own outage: split from a similar incident, or with no earlier incident at all', async () => {
    const earlier = await outage({ title: 'Westbury', status: 'PARTIALLY_RESTORED', localityIds: ['l2'], h: -5 });
    const r1 = await outage({ title: 'Westbury restored', status: 'RESTORED', retroactive: true, localityIds: ['l2'] });
    const restoreA = await post({ relevance: 'RESTORATION' });
    await join(r1.id, restoreA, { role: 'RESTORATION' });
    const r2 = await outage({ title: 'Lonely restored', status: 'RESTORED', retroactive: true, localityIds: ['l3'] });
    const restoreB = await post({ relevance: 'RESTORATION', h: 0.1 });
    await join(r2.id, restoreB, { role: 'RESTORATION', h: 0.1 });
    expect(earlier.id).toBeTruthy();
    const got = await reasonsOf([restoreA, restoreB]);
    expect(got[`${restoreA}:0`]).toEqual(['RESTORATION_SPLIT_FROM_INCIDENT']);
    expect(got[`${restoreB}:0`]).toEqual(['RESTORATION_NO_PRECEDING_INCIDENT']);
  });

  it('planned work and a fault on the same equipment', async () => {
    const node = await prisma.infraNode.create({ data: { type: 'SUBSTATION', name: 'Glenanda', normalizedKey: 'glenanda', firstSeenAt: T, lastSeenAt: T } });
    await outage({ title: 'Glenanda isolation', kind: 'PLANNED', status: 'PLANNED', localityIds: ['l4'], nodes: [node.id], h: -20 });
    const fault = await outage({ title: 'Glenanda', localityIds: ['l4'], nodes: [node.id] });
    const p = await post();
    await join(fault.id, p);
    expect((await reasonsOf([p]))[`${p}:0`]).toContain('KIND_CONFLICT');
  });

  it('a fault that produced no outage, an uncertain reading, and a tie-break that gave up', async () => {
    const a = await post({ readingOver: { confidence: 0.4 } });
    const b = await post({ h: 0.2 });
    await decide(b, 'NEW', null, 'digest post covering several faults: no outage created');
    const c = await post({ h: 0.4 });
    await decide(c, 'NEEDS_REVIEW', null, 'tie-break failed: 503');
    await prisma.retryAttempt.create({ data: { postId: c, faultIndex: 0, kind: 'TIEBREAK', attempts: 5, nextRetryAt: new Date('9999-01-01T00:00:00Z') } });
    const got = await reasonsOf([a, b, c]);
    expect(got[`${a}:0`]).toContain('UNCERTAIN_READING');
    expect(got[`${b}:0`]).toEqual(['DISCARDED_FAULT']);
    expect(got[`${c}:0`]).toContain('TIEBREAK_GAVE_UP');
  });

  it('new equipment whose name is very like a known station, seen once', async () => {
    const known = await prisma.infraNode.create({ data: { type: 'SUBSTATION', name: 'Kazerne', normalizedKey: 'kazerne', evidenceCount: 3, firstSeenAt: T, lastSeenAt: T } });
    const twin = await prisma.infraNode.create({ data: { type: 'SUBSTATION', name: 'Karzene', normalizedKey: 'karzene', evidenceCount: 1, firstSeenAt: T, lastSeenAt: T } });
    const o = await outage({ title: 'Droste Park', localityIds: ['l5'], nodes: [twin.id] });
    const p = await post();
    await join(o.id, p);
    await decide(p, 'NEW', o.id);
    expect(known.id).toBeTruthy();
    expect((await reasonsOf([p]))[`${p}:0`]).toContain('EQUIPMENT_IDENTITY');
  });

  it('a post that adds many new suburbs to an outage that already existed', async () => {
    const o = await outage({ title: 'Big', localityIds: ['l1'] });
    const a = await post();
    await join(o.id, a, { effect: { status: 'INVESTIGATING', locs: [{ id: 'l1', restored: false }] } });
    const b = await post({ h: 1, relevance: 'UPDATE' });
    await join(o.id, b, { role: 'UPDATE', h: 1, effect: { status: 'INVESTIGATING', locs: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].map((id) => ({ id, restored: false })) } });
    await decide(a, 'NEW', o.id);
    await decide(b, 'LINKED', o.id);
    expect((await reasonsOf([a, b]))[`${b}:0`]).toEqual(['CHANGED_SCOPE']);
  });
});

describe('B4: the queue', () => {
  const susp = (postId, ...codes) => ({ postId, faultIndex: 0, reasons: codes.map((code) => ({ code })) });

  it('queues items most urgent first, and a resolved item stays closed unless a NEW reason appears', async () => {
    const a = await post();
    const b = await post({ h: 1 });
    expect(await saveReviewItems({ prisma, suspicions: [susp(a, 'CHANGED_SCOPE'), susp(b, 'NEW_NEAR_ACTIVE', 'KIND_CONFLICT')] })).toBe(2);
    const open = await listReviewItems({ prisma });
    expect(open.map((i) => i.postId)).toEqual([b, a]); // b: 6, a: 1
    await resolveReviewItem({ prisma, id: open[0].id, status: 'DISMISSED', resolution: 'checked by hand: fine' });
    expect(await saveReviewItems({ prisma, suspicions: [susp(b, 'NEW_NEAR_ACTIVE', 'KIND_CONFLICT')] })).toBe(0); // same reasons: stays dismissed
    expect((await listReviewItems({ prisma, status: 'DISMISSED' })).map((i) => i.postId)).toEqual([b]);
    expect(await saveReviewItems({ prisma, suspicions: [susp(b, 'NEW_NEAR_ACTIVE', 'DISCARDED_FAULT')] })).toBe(1); // a new reason: reopened
    expect((await listReviewItems({ prisma })).map((i) => i.postId)).toContain(b);
  });

  it('never changes an outage', async () => {
    const o = await outage({ title: 'Untouched', localityIds: ['l1'] });
    const p = await post({ readingOver: { confidence: 0.3 } });
    await join(o.id, p);
    const before = await prisma.outage.findUnique({ where: { id: o.id } });
    await runReview({ prisma, postIds: [p], generate: async () => ({ text: JSON.stringify({ verdict: 'DISAGREE', evidence_quote: 'Power out', reason: 'x' }) }) });
    expect(await prisma.outage.findUnique({ where: { id: o.id } })).toEqual(before);
    expect(await prisma.outagePost.count()).toBe(1);
  });
});

describe('B4: the optional verifier', () => {
  const item = async (text = 'Fort Substation is 98% restored. Operators will attend on Monday morning.') => {
    const p = await post({ text });
    await saveReviewItems({ prisma, suspicions: [{ postId: p, faultIndex: 0, reasons: [{ code: 'NEW_NEAR_ACTIVE', detail: 'x' }] }] });
    return prisma.reviewItem.findFirst({ where: { postId: p } });
  };
  const answer = (o) => async () => ({ text: JSON.stringify(o) });

  it('a disagreement with a real quote is recorded and raises the priority (it changes nothing else)', async () => {
    const it0 = await item();
    const v = await verifyItem({ prisma, item: it0, generate: answer({ verdict: 'DISAGREE', evidence_quote: 'operators will attend on monday morning', reason: 'a different fault' }) });
    expect(v.verdict).toBe('DISAGREE');
    const after = await prisma.reviewItem.findUnique({ where: { id: it0.id } });
    expect(after.priority).toBe(it0.priority + 5);
    expect(after.verifier.quote).toMatch(/monday/);
    expect(after.status).toBe('OPEN');
  });

  it('an answer whose quote is not in the source is downgraded to UNSURE: no evidence, no verdict', async () => {
    const it0 = await item();
    const v = await verifyItem({ prisma, item: it0, generate: answer({ verdict: 'DISAGREE', evidence_quote: 'the substation exploded at noon', reason: 'sure' }) });
    expect(v.verdict).toBe('UNSURE');
    expect((await prisma.reviewItem.findUnique({ where: { id: it0.id } })).priority).toBe(it0.priority);
  });

  it('a provider failure is recorded as UNSURE, never thrown into the pipeline', async () => {
    const it0 = await item();
    const v = await verifyItem({ prisma, item: it0, generate: async () => { throw new Error('503 unavailable'); } });
    expect(v.verdict).toBe('UNSURE');
    expect(v.reason).toMatch(/could not be made/);
  });

  it('respects its daily cap', async () => {
    const a = await item();
    const b = await item();
    expect(await verifyItem({ prisma, item: a, generate: answer({ verdict: 'AGREE', evidence_quote: 'operators will attend', reason: 'ok' }), maxPerDay: 1 })).not.toBeNull();
    expect(await callsLeftToday(prisma, new Date(), 1)).toBe(0);
    expect(await verifyItem({ prisma, item: b, generate: answer({ verdict: 'AGREE', evidence_quote: 'operators will attend', reason: 'ok' }), maxPerDay: 1 })).toBeNull();
  });

  it('a review pass spot-checks clean posts (rate 1 here) and verifies the top items, within its per-run limit', async () => {
    const posts = [];
    for (let i = 0; i < 4; i++) posts.push(await post({ text: `Fort Substation update number ${i}: operators will attend on Monday morning`, h: i }));
    let calls = 0;
    const generate = async () => {
      calls += 1;
      return { text: JSON.stringify({ verdict: 'AGREE', evidence_quote: 'operators will attend on monday morning', reason: 'fine' }) };
    };
    const r = await runReview({ prisma, postIds: posts, generate, maxVerifications: 2 });
    expect(r).toMatchObject({ flagged: 4, opened: 4, verified: 2 });
    expect(calls).toBe(2);
    expect((await prisma.reviewItem.findMany()).every((i) => i.sampled)).toBe(true);
  });

  it('is off by default, and force overrides that for a one-off check', async () => {
    const it0 = await item();
    // (this file switched it on; the default is off, which the gate below checks through force=false with the flag temporarily off)
    const original = env.VERIFIER_ENABLED;
    env.VERIFIER_ENABLED = 'off';
    try {
      expect(await verifyItem({ prisma, item: it0, generate: answer({ verdict: 'AGREE', evidence_quote: 'operators will attend', reason: 'ok' }) })).toBeNull();
      expect(await verifyItem({ prisma, item: it0, force: true, generate: answer({ verdict: 'AGREE', evidence_quote: 'operators will attend', reason: 'ok' }) })).not.toBeNull();
    } finally {
      env.VERIFIER_ENABLED = original;
    }
  });
});
