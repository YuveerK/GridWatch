import { prisma as defaultDb } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { acceptedExtraction, checkPostDispositions, effectReadingMismatch, ingestionProblems, readingFaultItems, stuckProcessing } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { fingerprint, sourceMediaHash, caseId, json, ReviewError } from './contracts.js';
import { REASONS } from './suspicion.js';

const HOUR = 3600000;
export const EXPLANATIONS = {
  NEW_NEAR_ACTIVE: ['A new incident may duplicate an existing outage', 'The same interruption may appear twice on the map.'],
  RESTORATION_SPLIT_FROM_INCIDENT: ['This restoration may belong to another outage', 'The earlier outage may still appear active.'],
  RESTORATION_OTHER_SUBURB_ONLY_OPEN: ['An earlier outage may be missing its restoration', 'Customers may still see an interruption that the utility has restored.'],
  RESTORATION_NO_PRECEDING_INCIDENT: ['A restoration has no earlier incident on record', 'Check whether this is a valid historical restoration or a missed association.'],
  KIND_CONFLICT: ['Planned and unplanned incidents need comparison', 'Different events on nearby equipment may have been combined or duplicated.'],
  DISCARDED_FAULT: ['An interruption did not produce an incident', 'An affected area may be missing from the map.'],
  EQUIPMENT_IDENTITY: ['Two equipment names may refer to the same asset', 'An identity mismatch can send updates to the wrong incident.'],
  UNCERTAIN_READING: ['The meaning of this post needs checking', 'An uncertain reading may give the wrong areas or outage status.'],
  CHANGED_SCOPE: ['This update added several affected areas', 'Check that each added area is supported by the source.'],
  TIEBREAK_GAVE_UP: ['Automatic matching needs your decision', 'Automatic retries are exhausted; this fault may have no incident.'],
  BLOCKED: ['GridWatch could not decide where this fault belongs', 'This fault has not been reliably associated with an incident.'],
  MISSING_DISPOSITION: ['A fault is missing a valid processing result', 'Its outage or timeline may be missing or inconsistent.'],
  READING_FAILURE: ['GridWatch could not read this post reliably', 'The source may contain an interruption that has not reached the map.'],
  READING_CONFLICT: ['A saved human reading needs checking', 'The source changed or the saved correction is incompatible; it cannot be applied safely.'],
  PROCESSING_ERROR: ['Processing this post failed', 'Its incident information may be incomplete.'],
  WAITING: ['This post is waiting for automatic processing', 'No decision is needed yet.'],
  RETRY_WAITING: ['An automatic matching retry is scheduled', 'The engine will try again; you can inspect the evidence in the meantime.'],
  STUCK: ['A processing worker stopped before finishing', 'This post needs a guarded retry.'],
  OPERATIONAL: ['The pipeline needs attention', 'Recent information may be incomplete even if the decision queue is empty.'],
  SAMPLE: ['A routine spot check is available', 'No known problem was detected.'],
  RECOVERY: ['A correction needs recovery', 'The previous operation did not finish; inspect its durable journal before retrying.'],
};
export const postInclude = { extractions: { orderBy: { createdAt: 'desc' } }, readingOverride: true, linkDecisions: true, outagePosts: { include: { outage: { select: { serviceType: true,municipalityId: true,status: true,waterState: true,lastUpdateAt: true } } } }, retries: true, reviewItems: true, PostMedia: true };
export function postFingerprint(post) {
  const e = acceptedExtraction(post);
  return fingerprint({ text: post.noteTweetText || post.text, service: post.serviceType, reading: e?.result, conflict: e?.humanConflict,
    media: sourceMediaHash(post),
    decisions: [...post.linkDecisions].sort((a,b) => a.faultIndex-b.faultIndex).map((d) => [d.faultIndex, d.outcome, d.outageId, d.reason]),
    effects: [...post.outagePosts].sort((a,b) => a.faultIndex-b.faultIndex).map((d) => [d.faultIndex,d.outageId,d.effect]),
    retries: post.retries.map((r) => [r.faultIndex,r.kind,r.attempts,r.nextRetryAt]), override: post.readingOverride?.revision });
}
const keyFor = (postId, faultIndex) => `post:${postId}:${faultIndex == null ? 'reading' : faultIndex}`;
const resultFor = (post, extraction, items, account, faultIndex, reasons, tab = 'decision', blocked = false) => {
  const subjectKey = keyFor(post.id, faultIndex);
  const fault = items.find((f) => f.faultIndex === faultIndex);
  const r = fault?.extraction.result ?? extraction?.result;
  const sortedReasons = reasons.sort((a,b) => (REASONS[b.code]?.weight ?? 3) - (REASONS[a.code]?.weight ?? 3));
  const [title, consequence] = EXPLANATIONS[sortedReasons[0]?.code] ?? EXPLANATIONS.OPERATIONAL;
  return { id: caseId(subjectKey), subjectKey, postId: post.id, faultIndex, source: post.sourceAccount, serviceType: post.serviceType,
    municipality: account?.Municipality?.code ?? null, municipalityId: account?.municipalityId ?? null, category: sortedReasons[0]?.code,
    title, consequence, reasons: sortedReasons, priority: reasons.reduce((n,r) => n+(REASONS[r.code]?.weight ?? 3),0), tab, blocked,
    sampled: reasons.every((r) => r.code === 'SAMPLE'), fingerprint: fingerprint({ evidence: postFingerprint(post),reasons: sortedReasons }), publishedAt: post.publishedAt, createdAt: post.createdAt,
    text: post.noteTweetText || post.text, externalId: post.externalId, label: (r?.entities ?? []).map((n) => n.name).join(', ') || (r?.localities ?? []).map((l) => l.name).join(', ') || 'Source post',
    nextRetryAt: post.retries.find((r) => r.faultIndex === faultIndex && r.nextRetryAt.getUTCFullYear() < 9000)?.nextRetryAt ?? null,
    retryAttempts: post.retries.find((r) => r.faultIndex === faultIndex)?.attempts ?? null,
    verifier: post.reviewItems.find((i) => i.faultIndex === faultIndex)?.verifier ?? null };
};

export function casesForPost(post, account, now = new Date()) {
  const extraction = acceptedExtraction(post);
  const items = extraction?.result ? readingFaultItems(post, extraction, faultItems) : [];
  const groups = new Map();
  const add = (index, reason, tab = 'decision', blocked = false) => {
    const cur = groups.get(index) ?? { reasons: [], tab, blocked };
    if (!cur.reasons.some((r) => r.code === reason.code)) cur.reasons.push(reason);
    if (tab === 'decision') cur.tab = tab;
    cur.blocked ||= blocked;
    groups.set(index, cur);
  };
  const readingFailed = extraction?.humanConflict || (!extraction?.result && ['NEEDS_REVIEW','PROCESSING_ERROR','RELEVANT'].includes(post.processingStatus));
  if (readingFailed) add(null, { code: extraction?.humanConflict ? 'READING_CONFLICT' : 'READING_FAILURE', detail: extraction?.error ?? 'No accepted current-service reading is available.' }, 'decision', true);
  for (const d of post.linkDecisions) if (d.outcome === 'NEEDS_REVIEW') {
    if (readingFailed) continue;
    const retry = post.retries.find((r) => r.faultIndex === d.faultIndex && r.nextRetryAt.getUTCFullYear() < 9000);
    add(d.faultIndex, { code: retry ? 'RETRY_WAITING' : 'BLOCKED', detail: d.reason }, retry ? 'waiting' : 'decision', !retry);
  }
  for (const p of post.outagePosts) if (p.outage && (p.outage.serviceType !== post.serviceType || account?.municipalityId && p.outage.municipalityId && p.outage.municipalityId !== account.municipalityId)) add(p.faultIndex, { code: 'MISSING_DISPOSITION', detail: 'The published association crosses a service or known municipality boundary.' }, 'decision', true);
  for (const item of items) {
    const d = post.linkDecisions.filter((x) => x.faultIndex === item.faultIndex);
    const op = post.outagePosts.filter((x) => x.faultIndex === item.faultIndex);
    const check = checkPostDispositions({ expectedIndices: [item.faultIndex], decisions: d, outagePosts: op });
    if (check.problems.length && !d.some((x) => x.outcome === 'NEEDS_REVIEW') && !['UNPROCESSED','PROCESSING'].includes(post.processingStatus)) add(item.faultIndex, { code: 'MISSING_DISPOSITION', detail: check.problems.join('; ') }, 'decision', true);
    if (op.some((p) => effectReadingMismatch(p.effect, extraction.result))) add(item.faultIndex, { code: 'MISSING_DISPOSITION', detail: 'The current interpretation and published timeline effect differ.' }, 'decision', true);
    if (['OUTAGE','UPDATE','RESTORATION','PLANNED_OUTAGE'].includes(item.extraction.relevance) && check.excluded.some((e) => !/unsupported service|system status board/i.test(e.reason))) add(item.faultIndex, { code: 'DISCARDED_FAULT', detail: check.excluded.map((e) => e.reason).join('; ') }, 'decision');
  }
  for (const r of [...post.linkDecisions,...post.outagePosts]) if (items.length && !items.some((i) => i.faultIndex === r.faultIndex)) add(r.faultIndex, { code: 'MISSING_DISPOSITION', detail: 'Historical effects remain for a section missing from the current reading.' }, 'decision', true);
  if (!readingFailed && post.processingStatus === 'NEEDS_REVIEW' && !groups.size) add(null, { code: 'UNCERTAIN_READING', detail: 'The post remains marked for review.' }, 'decision', true);
  if (!readingFailed && post.processingStatus === 'PROCESSING_ERROR') add(null, { code: 'PROCESSING_ERROR', detail: 'Processing failed after reading the source.' }, 'decision', true);
  if (stuckProcessing([post], now.getTime()).length) add(null, { code: 'STUCK', detail: 'Processing has not completed for over 30 minutes.' }, 'decision', true);
  else if (['UNPROCESSED','PROCESSING'].includes(post.processingStatus)) add(null, { code: 'WAITING', detail: account?.incomplete ? 'Waiting for this source’s incomplete fetch to finish.' : 'Waiting for the next processing cycle.' }, 'waiting');
  for (const r of post.retries) if (r.nextRetryAt.getUTCFullYear() >= 9000 && !readingFailed) add(r.faultIndex, { code: 'TIEBREAK_GAVE_UP', detail: 'Automatic retries are exhausted.' }, 'decision', true);
  for (const review of post.reviewItems) {
    const changed = review.evidenceFingerprint && review.evidenceFingerprint !== postFingerprint(post);
    if (review.status !== 'OPEN' && !changed) continue;
    for (const r of review.reasons) {
      if (readingFailed && r.code === 'UNCERTAIN_READING') continue;
      // A scheduled provider retry is informational until its bounded attempts are exhausted.
      if (r.code === 'UNCERTAIN_READING' && groups.get(review.faultIndex)?.tab === 'waiting') continue;
      add(r.code === 'UNCERTAIN_READING' && (extraction?.result?.review_reason || extraction?.result?.confidence < .75 || !groups.has(review.faultIndex)) ? null : review.faultIndex, r);
    }
  }
  return [...groups].map(([index, group]) => resultFor(post, extraction, items, account, index, group.reasons, group.tab, group.blocked));
}

export async function sourceHealth(db = defaultDb, now = new Date()) {
  const [accounts, states, quality, runs, leases, checks, running] = await Promise.all([
    db.sourceAccount.findMany({ where: { active: true }, include: { Municipality: true } }), db.ingestionState.findMany(),
    db.cycleQuality.findFirst({ where: { status: { not: 'RUNNING' } }, orderBy: { finishedAt: 'desc' } }),
    db.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, distinct: ['sourceAccountId'] }),
    db.workLease.findMany({ where: { expiresAt: { gt: now } } }),
    db.$queryRaw`SELECT sp."sourceAccount" AS source, max(c."finishedAt") AS checked
      FROM "CycleQuality" c CROSS JOIN LATERAL jsonb_array_elements(c.posts) entry
      JOIN "SourcePost" sp ON sp.id = entry->>'postId'
      WHERE c.status <> 'RUNNING' GROUP BY sp."sourceAccount"`,
    db.cycleQuality.findFirst({ where: { status: 'RUNNING' },orderBy: { startedAt: 'desc' } }),
  ]);
  const health = accounts.map((a) => {
    const state = states.find((s) => s.accountId === a.externalId);
    const run = runs.find((r) => r.sourceAccountId === a.id);
    const problems = ingestionProblems(state, now.getTime());
    if (run?.status === 'RUNNING' && now - run.startedAt > 30*60000) problems.push('The latest fetch has been running for over 30 minutes without completing.');
    if (run && ['FAILED','RATE_LIMITED'].includes(run.status)) problems.push(`Latest fetch ${run.status.toLowerCase().replaceAll('_',' ')}.`);
    const sourceCheck = quality?.summary?.sourceChecks?.find((c) => c.source === a.displayName);
    const lastCheck = sourceCheck?.checkedAt ?? checks.find((c) => c.source === a.displayName)?.checked ?? null;
    if (!lastCheck) problems.push('No completed processing/check coverage is recorded for this source.');
    else if (now - new Date(lastCheck) > 6*HOUR) problems.push('Processing/check coverage for this source is over six hours old.');
    if (sourceCheck?.incomplete) problems.push('This source was not completely processed and checked in the latest cycle.');
    return { ...a, incomplete: state?.incomplete ?? false, lastCompletedFetch: state?.lastCompletedAt ?? null,
      lastPoll: run?.completedAt ?? run?.startedAt ?? null, latestFetchStatus: run?.status ?? 'UNKNOWN', latestPostsInserted: run?.postsInserted ?? null,
      lastCheck, problems };
  });
  const problems = [];
  if (running && (!quality || running.startedAt > quality.startedAt) && now - running.startedAt > HOUR) problems.push('A processing/check cycle stopped before completing; its running record is over an hour old.');
  if (!quality) problems.push('No completed processing/check cycle has been recorded.');
  else {
    if (now - quality.finishedAt > 6*HOUR) problems.push('The latest processing/check result is over six hours old.');
    if (['FAILED','INCOMPLETE'].includes(quality.status)) problems.push(`Latest cycle ${quality.status.toLowerCase()}: ${(quality.summary?.incomplete ?? [quality.summary?.failedStage ?? 'check the cycle details']).join(', ')}.`);
  }
  return { accounts: health, quality, problems, busy: leases.some((l) => l.name === 'pipeline'), checkedAt: now };
}

export async function collectCases(db = defaultDb, now = new Date()) {
  const [health, indexed, recovery] = await Promise.all([
    sourceHealth(db, now),
    db.reviewCase.findMany(), db.reviewAction.findMany({ where: { state: { in: ['APPLYING','RECOVERY_REQUIRED'] } } }),
  ]);
  const byKey = new Map(indexed.map((c) => [c.subjectKey,c]));
  const live = [];
  let cursor;
  for (;;) {
    const posts = await db.sourcePost.findMany({ take: 500,orderBy: { id: 'asc' },...(cursor ? { cursor: { id: cursor },skip: 1 } : {}),include: postInclude });
    live.push(...posts.flatMap((p) => casesForPost(p,health.accounts.find((a) => a.displayName === p.sourceAccount),now)));
    if (posts.length < 500) break;
    cursor = posts.at(-1).id;
  }
  for (const a of health.accounts) if (a.problems.length) {
    const subjectKey = `source:${a.id}:ingestion`;
    live.push({ id: caseId(subjectKey), subjectKey, source: a.displayName, stage: 'ingestion', serviceType: a.serviceType,
      municipality: a.Municipality?.code, title: `${a.displayName}: pipeline coverage needs attention`, consequence: EXPLANATIONS.OPERATIONAL[1], reasons: a.problems.map((detail) => ({ code: 'OPERATIONAL', detail })), category: 'OPERATIONAL', priority: 8, blocked: true, tab: 'decision', sampled: false,
      fingerprint: fingerprint({ problems: a.problems, lastPoll: a.lastPoll, status: a.latestFetchStatus,lastCheck: a.lastCheck }), createdAt: a.lastPoll ?? a.createdAt, publishedAt: a.lastPoll ?? a.createdAt });
  }
  if (health.problems.length) {
    const subjectKey = 'pipeline:quality';
    live.push({ id: caseId(subjectKey), subjectKey, stage: 'quality', title: 'Processing and checks need attention', consequence: EXPLANATIONS.OPERATIONAL[1], reasons: health.problems.map((detail) => ({ code: 'OPERATIONAL', detail })), category: 'OPERATIONAL', priority: 8, blocked: true, tab: 'decision', sampled: false,
      fingerprint: fingerprint({ qualityId: health.quality?.id, problems: health.problems }), createdAt: health.quality?.finishedAt ?? now, publishedAt: health.quality?.finishedAt ?? now });
  }
  // Quality contradiction records remain actionable until their *current* affected outage is consistent.
  for (const p of health.quality?.problems ?? []) if (p.outageId) {
    const o = await db.outage.findUnique({ where: { id: p.outageId }, include: { localities: true } });
    if (!o) continue;
    const bad = ['ACTIVE','PARTIALLY_RESTORED'].includes(o.status) && o.localities.length && o.localities.every((l) => l.restored) || o.status === 'RESTORED' && o.localities.some((l) => !l.restored);
    if (!bad) continue;
    const subjectKey = `outage:${o.id}:quality`;
    live.push({ id: caseId(subjectKey), subjectKey, outageId: o.id, stage: 'quality', title: `The state of ${o.title} is inconsistent`, consequence: 'The displayed status conflicts with the affected areas.', reasons: [{ code: 'OPERATIONAL', detail: p.message }], category: 'OPERATIONAL', priority: 9, blocked: true, tab: 'decision', sampled: false, serviceType: o.serviceType,
      fingerprint: fingerprint([o.status,o.localities]), createdAt: o.lastUpdateAt, publishedAt: o.lastUpdateAt });
  }
  const cases = live.map((c) => {
    const saved = byKey.get(c.subjectKey);
    const same = saved?.fingerprint === c.fingerprint;
    const tab = saved?.workflow === 'ENGINEERING' ? 'engineering' : same && saved.workflow === 'CONFIRMED' && !c.blocked ? 'history' : c.tab;
    return { ...c, indexed: Boolean(saved),indexChanged: !same,tab, workflow: saved?.workflow === 'ENGINEERING' ? 'ENGINEERING' : same && saved?.workflow !== 'AUTO_RESOLVED' ? saved?.workflow ?? 'OPEN' : 'OPEN', note: saved?.note ?? null, createdAt: saved?.createdAt ?? c.createdAt };
  });
  const liveIds = new Set(cases.map((c) => c.id));
  for (const saved of indexed) if (!liveIds.has(saved.id)) cases.push({ ...saved.summary, ...saved, blocked: false,conditionPresent: false,tab: saved.workflow === 'ENGINEERING' ? 'engineering' : 'history', workflow: saved.workflow === 'OPEN' ? 'AUTO_RESOLVED' : saved.workflow });
  for (const action of recovery) {
    const c = cases.find((c) => c.id === action.caseId);
    if (c) { c.tab = 'engineering'; c.blocked = true; c.reasons = [...c.reasons, { code: 'RECOVERY', detail: `Action ${action.id} needs inspection/recovery.` }]; }
  }
  cases.sort((a,b) => Number(b.blocked)-Number(a.blocked) || Number(b.category?.includes('RESTORATION'))-Number(a.category?.includes('RESTORATION')) || b.priority-a.priority || new Date(a.createdAt)-new Date(b.createdAt) || a.id.localeCompare(b.id));
  return { cases, health };
}

export function filterCases(cases, q, now = new Date()) {
  return cases.filter((c) => c.tab === q.tab && (q.sampled === 'true' || !c.sampled) && (q.service === 'ALL' || c.serviceType === q.service)
    && (!q.source || c.source === q.source) && (!q.municipality || c.municipality === q.municipality)
    && (!q.category || c.reasons?.some((r) => r.code === q.category))
    && (!q.q || `${c.title} ${c.text ?? ''} ${c.externalId ?? ''} ${c.postId ?? ''} ${c.label ?? ''}`.toLowerCase().includes(q.q.toLowerCase()))
    && (q.age === 'all' || (q.age === 'day' ? now-new Date(c.createdAt) < 24*HOUR : q.age === 'week' ? now-new Date(c.createdAt) < 168*HOUR : now-new Date(c.createdAt) >= 168*HOUR)));
}
export async function listCases(q, db = defaultDb) {
  const { cases } = await collectCases(db);
  const selected = filterCases(cases,q);
  return { data: selected.slice(q.offset,q.offset+q.limit).map(({ text,...c }) => ({ ...c, text: text?.slice(0,220) })), total: selected.length,counts: Object.fromEntries(['decision','waiting','engineering','history'].map((tab) => [tab,filterCases(cases,{ ...q,tab,sampled: 'false' }).length])), offset: q.offset, limit: q.limit, hasMore: q.offset+q.limit < selected.length };
}
export async function reviewSummary(db = defaultDb) {
  const { cases, health } = await collectCases(db);
  const counts = Object.fromEntries(['decision','waiting','engineering','history'].map((tab) => [tab,cases.filter((c) => c.tab === tab && !c.sampled).length]));
  return { counts, actionable: counts.decision+counts.engineering,accounts: health.accounts.map(({ externalId,...a }) => a), pipeline: { problems: health.problems, quality: health.quality, busy: health.busy, checkedAt: health.checkedAt }, correctionsEnabled: env.REVIEW_CORRECTIONS_ENABLED === 'on' };
}
export async function getCase(id, db = defaultDb) {
  const { cases, health } = await collectCases(db);
  const c = cases.find((c) => c.id === id);
  if (!c) throw new ReviewError('not_found','This review case was not found.',404);
  return { ...c, health };
}
export async function ensureCase(c, db = defaultDb) {
  const { health,...summary } = c;
  return db.reviewCase.upsert({ where: { id: c.id }, create: { id: c.id, subjectKey: c.subjectKey, postId: c.postId ?? null, faultIndex: c.faultIndex ?? null, source: c.source ?? null, stage: c.stage ?? null, fingerprint: c.fingerprint, summary: json(summary),workflow: c.workflow ?? 'OPEN',note: c.note ?? null,createdAt: c.createdAt ? new Date(c.createdAt) : undefined },
    update: { fingerprint: c.fingerprint, summary: json(summary), ...(c.workflow === 'OPEN' ? { workflow: 'OPEN' } : {}) } });
}
export async function reconcileCases({ prisma = defaultDb, limit = 500 } = {}) {
  const { cases } = await collectCases(prisma);
  const pending = cases.filter((c) => c.tab !== 'history' && (!c.indexed || c.indexChanged));
  const selected = pending.sort((a,b) => Number(a.indexed)-Number(b.indexed)).slice(0,limit);
  for (const c of selected) await ensureCase(c,prisma);
  const settled = cases.filter((c) => c.workflow === 'AUTO_RESOLVED');
  for (const c of settled.slice(0,limit)) await prisma.reviewCase.update({ where: { id: c.id }, data: { workflow: 'AUTO_RESOLVED' } });
  return { indexed: selected.length, resolved: Math.min(settled.length,limit), remaining: Math.max(0,pending.length-limit) };
}
