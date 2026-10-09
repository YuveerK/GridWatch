import { beforeEach, describe, expect, it } from 'vitest';

// No mocking needed: these tests never process a post through the pipeline (no extractPost call anywhere below).
const { setOverride } = await import('../../src/modules/outages/overrides.js');
const { prisma, resetDb } = await import('./db.js');
const { importExistingCorrections, applicableLessons, findLessonConflicts, setLessonStatus } = await import('../../src/modules/self-correction/lessons.js');
const { buildEvidenceEnvelope } = await import('../../src/modules/self-correction/evidence.js');

const { readerFor } = await import('../../src/modules/ai/reader-registry.js');
const { env } = await import('../../src/config/env.js');

const T0 = new Date('2026-09-10T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

let n = 0;
async function addPost(min, extra = {}) {
  n += 1;
  const id = `lsn${n}`;
  await prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: String(9800 + n), text: 'x', publishedAt: at(min), updatedAt: at(min), conversationId: String(9800 + n), ...extra } });
  return id;
}

/** Give a post an accepted reading directly (no AI, no pipeline) so buildEvidenceEnvelope can proceed past its post-has-no-reading early return. */
async function withAcceptedReading(postId, serviceType = 'ELECTRICITY') {
  const promptVersion = readerFor(serviceType).promptVersion ?? env.AI_PROMPT_VERSION;
  await prisma.postExtraction.create({
    data: { postId, promptVersion, model: 'test', status: 'SUCCEEDED', relevance: 'OUTAGE', result: { relevance: 'OUTAGE', status: 'INVESTIGATING', sdc: null, entities: [], localities: [], faults: [], eta_text: null, cause: null, restoration_percent: null, update_summary: 'x', confidence: 0.9, image_text: null } },
  });
}

beforeEach(async () => {
  await resetDb();
  n = 0;
});

describe('importExistingCorrections', () => {
  it('imports each human LinkOverride as a CANDIDATE lesson, idempotently', async () => {
    const anchor = await addPost(0);
    const corrected = await addPost(60);
    await setOverride({ postId: corrected, faultIndex: 0, action: 'JOIN', anchorPostId: anchor, note: 'same Dale Lace Avenue mini-substation, still waiting on procurement' });

    const first = await importExistingCorrections({ prisma, dryRun: false });
    expect(first.created).toHaveLength(1);
    expect(first.created[0].status).toBe('CANDIDATE');
    expect(first.created[0].kind).toBe('INCIDENT_CONTINUATION');

    const second = await importExistingCorrections({ prisma, dryRun: false });
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(await prisma.correctionLesson.count()).toBe(1);
  });

  it('a preview import creates nothing', async () => {
    const anchor = await addPost(0);
    const corrected = await addPost(60);
    await setOverride({ postId: corrected, faultIndex: 0, action: 'JOIN', anchorPostId: anchor, note: 'x' });
    await importExistingCorrections({ prisma, dryRun: true });
    expect(await prisma.correctionLesson.count()).toBe(0);
  });

  it('a SPLIT override with a contrastPostId imports as INCIDENT_SEPARATION and records the counterexample', async () => {
    const subject = await addPost(0);
    const contrast = await addPost(5);
    await setOverride({ postId: subject, faultIndex: 0, action: 'SPLIT', contrastPostId: contrast, note: 'Bree Street, separate from the John Ware fault' });
    const { created } = await importExistingCorrections({ prisma, dryRun: false });
    expect(created[0].kind).toBe('INCIDENT_SEPARATION');
    const withSupports = await prisma.correctionLesson.findUnique({ where: { id: created[0].id }, include: { supports: true } });
    expect(withSupports.supports.some((s) => s.postId === contrast && s.role === 'CONTRADICT')).toBe(true);
  });
});

describe('a reviewed, promoted lesson is retrievable for a later, independent case', () => {
  it('applicableLessons reaches a DIFFERENT post in the same scope once the lesson is ACTIVE, and feeds that post\'s evidence envelope', async () => {
    const anchor = await addPost(0);
    const corrected = await addPost(60);
    await setOverride({ postId: corrected, faultIndex: 0, action: 'JOIN', anchorPostId: anchor, note: 'reviewed continuation example' });
    const { created } = await importExistingCorrections({ prisma, dryRun: false, now: at(60) });
    const lesson = created[0];

    // a later, UNRELATED post: no override on it, no mention of the corrected/anchor posts anywhere
    const laterPost = await addPost(180);
    await withAcceptedReading(laterPost);

    // before promotion (still CANDIDATE), it must not be retrievable as applicable
    expect(await applicableLessons({ prisma, serviceType: 'ELECTRICITY', sourceAccount: 'a', asOf: at(180) })).toHaveLength(0);

    await setLessonStatus({ prisma, id: lesson.id, status: 'REVIEWED' });
    await setLessonStatus({ prisma, id: lesson.id, status: 'ACTIVE' });

    const applicable = await applicableLessons({ prisma, serviceType: 'ELECTRICITY', sourceAccount: 'a', asOf: at(180) });
    expect(applicable.map((l) => l.id)).toContain(lesson.id);

    // the mechanism that actually feeds a decision: this later, independent post's own evidence envelope includes
    // the lesson in its lessonSetFingerprint - without any post-id exception and without copying the human override
    const envelope = await buildEvidenceEnvelope({ prisma, postId: laterPost, faultIndex: 0 });
    expect(envelope.lessons.map((l) => l.id)).toContain(lesson.id);
  });

  it('a lesson is never retrievable before its effective time (chronological replay must not see the future)', async () => {
    const anchor = await addPost(0);
    const corrected = await addPost(60);
    await setOverride({ postId: corrected, faultIndex: 0, action: 'JOIN', anchorPostId: anchor, note: 'x' });
    const { created } = await importExistingCorrections({ prisma, dryRun: false, now: at(60) });
    await setLessonStatus({ prisma, id: created[0].id, status: 'REVIEWED' });
    await setLessonStatus({ prisma, id: created[0].id, status: 'ACTIVE' });
    expect(await applicableLessons({ prisma, serviceType: 'ELECTRICITY', sourceAccount: 'a', asOf: at(-10) })).toHaveLength(0);
    expect(await applicableLessons({ prisma, serviceType: 'ELECTRICITY', sourceAccount: 'a', asOf: at(120) })).toHaveLength(1);
  });

  it('a lesson scoped to another source account does not leak into this one\'s decisions', async () => {
    const anchor = await addPost(0, { sourceAccount: 'CityPowerJhb' });
    const corrected = await addPost(60, { sourceAccount: 'CityPowerJhb' });
    await setOverride({ postId: corrected, faultIndex: 0, action: 'JOIN', anchorPostId: anchor, note: 'x' });
    const { created } = await importExistingCorrections({ prisma, dryRun: false, now: at(60) });
    await setLessonStatus({ prisma, id: created[0].id, status: 'REVIEWED' });
    await setLessonStatus({ prisma, id: created[0].id, status: 'ACTIVE' });
    expect(await applicableLessons({ prisma, serviceType: 'ELECTRICITY', sourceAccount: 'CityTshwane', asOf: at(120) })).toHaveLength(0);
    expect(await applicableLessons({ prisma, serviceType: 'ELECTRICITY', sourceAccount: 'CityPowerJhb', asOf: at(120) })).toHaveLength(1);
  });
});

describe('findLessonConflicts', () => {
  it('flags two active lessons that answer the same applicability predicate with opposite claims', () => {
    const a = { id: 'l1', kind: 'INCIDENT_CONTINUATION', applicabilityPredicate: { sourcePostId: 'p1', sourceFaultIndex: 0 }, claim: { action: 'JOIN' } };
    const b = { id: 'l2', kind: 'INCIDENT_CONTINUATION', applicabilityPredicate: { sourcePostId: 'p1', sourceFaultIndex: 0 }, claim: { action: 'SPLIT' } };
    expect(findLessonConflicts([a, b])).toHaveLength(1);
  });

  it('does not flag lessons that answer different questions', () => {
    const a = { id: 'l1', kind: 'INCIDENT_CONTINUATION', applicabilityPredicate: { sourcePostId: 'p1', sourceFaultIndex: 0 }, claim: { action: 'JOIN' } };
    const b = { id: 'l2', kind: 'INCIDENT_CONTINUATION', applicabilityPredicate: { sourcePostId: 'p2', sourceFaultIndex: 0 }, claim: { action: 'JOIN' } };
    expect(findLessonConflicts([a, b])).toHaveLength(0);
  });
});

describe('setLessonStatus', () => {
  it('requires a reason to suspend or retire a lesson', async () => {
    const anchor = await addPost(0);
    const corrected = await addPost(60);
    await setOverride({ postId: corrected, faultIndex: 0, action: 'JOIN', anchorPostId: anchor, note: 'x' });
    const { created } = await importExistingCorrections({ prisma, dryRun: false });
    await expect(setLessonStatus({ prisma, id: created[0].id, status: 'RETIRED' })).rejects.toThrow(/reason/);
    const retired = await setLessonStatus({ prisma, id: created[0].id, status: 'RETIRED', reason: 'the pattern no longer held' });
    expect(retired.status).toBe('RETIRED');
    expect(retired.revocationReason).toBe('the pattern no longer held');
  });
});
