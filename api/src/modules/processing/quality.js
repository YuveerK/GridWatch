import { readingRevision } from '../../lib/reading-revision.js';

// Checks that say whether the engine's WORK is complete and consistent, not just that it ran. Pure functions over rows already read
// from the database, so each rule can be tested on its own and the scripts (npm run batch, npm run audit) stay thin.

/**
 * For one post: every expected fault must have exactly one accepted disposition, a linked disposition must have its timeline entry, and
 * anything intentionally excluded must say why. Returns what is wrong and what was deliberately left out.
 *   expectedIndices: fault numbers the reading calls for (from faultItems)
 *   decisions:  [{ faultIndex, outcome, outageId, reason }]
 *   outagePosts: [{ faultIndex, outageId }]
 */
export function checkPostDispositions({ expectedIndices, decisions, outagePosts }) {
  const problems = [];
  const excluded = [];
  const byIndex = new Map();
  for (const d of decisions) byIndex.set(d.faultIndex, [...(byIndex.get(d.faultIndex) ?? []), d]);
  for (const i of expectedIndices) {
    const ds = byIndex.get(i) ?? [];
    if (ds.length === 0) problems.push(`fault ${i} has no disposition`);
    else if (ds.length > 1) problems.push(`fault ${i} has ${ds.length} dispositions`);
    for (const d of ds) {
      if (d.outcome === 'LINKED') {
        if (!outagePosts.some((p) => p.faultIndex === i && p.outageId === d.outageId)) problems.push(`fault ${i} says linked but has no timeline entry`);
      } else if (d.outcome === 'NEW' && !d.outageId && !outagePosts.some((p) => p.faultIndex === i)) {
        // no outage was created or joined: fine for notices and summaries, but it must be visible, with its reason
        excluded.push({ faultIndex: i, reason: d.reason ?? 'no reason recorded' });
        if (!d.reason) problems.push(`fault ${i} was left out with no reason`);
      } else if (d.outcome === 'NEEDS_REVIEW') {
        problems.push(`fault ${i} needs review: ${d.reason ?? ''}`.trim());
      }
    }
  }
  for (const i of byIndex.keys()) if (!expectedIndices.includes(i)) problems.push(`a disposition exists for fault ${i}, which the current reading does not have`);
  for (const p of outagePosts) if (!expectedIndices.includes(p.faultIndex)) problems.push(`a timeline entry exists for fault ${p.faultIndex}, which the current reading does not have`);
  return { problems, excluded };
}

/** Does an outage effect still match the reading it was built from? null when the effect predates revisions (nothing to compare). */
export function effectReadingMismatch(effect, currentResult) {
  if (!effect?.reading) return null;
  return effect.reading !== readingRevision(currentResult);
}

const HOUR = 3_600_000;
/** Planned work that should have been closed: its announced window ended long ago, or (no window known) nothing was said for `undatedHours`. */
export function plannedOverdue(o, now = Date.now(), { graceHours = 6, undatedHours = 240 } = {}) {
  if (o.status !== 'PLANNED') return false;
  if (o.scheduledEnd) return now - new Date(o.scheduledEnd).getTime() > graceHours * HOUR;
  return now - new Date(o.lastUpdateAt).getTime() > undatedHours * HOUR;
}

/** Posts left in PROCESSING for longer than `maxMinutes`: a worker died mid-post. */
export function stuckProcessing(posts, now = Date.now(), maxMinutes = 30) {
  return posts.filter((p) => p.processingStatus === 'PROCESSING' && p.processingStartedAt && now - new Date(p.processingStartedAt).getTime() > maxMinutes * 60_000);
}

/** The ingestion position is unhealthy: an unfinished sweep of X's timeline, or none completed for `maxHours`. */
export function ingestionProblems(state, now = Date.now(), maxHours = 6) {
  if (!state) return ['no ingestion state recorded yet'];
  const out = [];
  if (state.incomplete) out.push('the last fetch did not finish (the saved position resumes it)');
  if (!state.lastCompletedAt) out.push('no fetch has ever completed');
  else if (now - new Date(state.lastCompletedAt).getTime() > maxHours * HOUR) out.push(`the last completed fetch was over ${maxHours} hours ago`);
  return out;
}

/** The N most recent fetch runs that brought posts, found directly (however many empty polls came after them). */
export async function latestNonemptyRuns(prisma, n = 1) {
  return prisma.ingestionRun.findMany({ where: { postsInserted: { gt: 0 } }, orderBy: { startedAt: 'desc' }, take: Math.max(1, n) });
}

// ───────────── the saved quality result of one cycle ─────────────

/**
 * The verdict on a cycle, from what happened. Pure.
 *   FAILED        the cycle itself threw
 *   INCOMPLETE    work is missing: a stage was skipped, posts are still waiting, the fetch did not finish, or work is stuck
 *   NEEDS_REVIEW  the work ran, but some result needs a person (a check failed, a post or fault awaits review)
 *   COMPLETE      everything that should have happened did, and every check passed
 */
export function decideStatus({ error = null, incomplete = [], backlog = 0, ingestionIncomplete = false, stuck = 0, problems = 0, needsReview = 0 }) {
  if (error) return 'FAILED';
  if (incomplete.length || backlog > 0 || ingestionIncomplete || stuck > 0) return 'INCOMPLETE';
  if (problems > 0 || needsReview > 0) return 'NEEDS_REVIEW';
  return 'COMPLETE';
}

/**
 * Run the deterministic checks over exactly the posts a cycle covered and save the result (a CycleQuality row). Never throws into the
 * cycle: a failure to assess is itself recorded as a problem.
 *   posts covered = the posts this cycle's fetch inserted, plus every post processed since it started (a backlog counts too)
 */
export async function assessCycle({ prisma, faultItems, promptVersion, trigger, startedAt, ingestionRunId = null, ingestion = null, tally = {}, backlog = 0, incomplete = [], error = null, now = new Date() }) {
  const problems = [];
  const covered = new Map();
  const runPostIds = ingestionRunId ? (await prisma.ingestionRunPost.findMany({ where: { ingestionRunId }, select: { postId: true } })).map((r) => r.postId) : [];
  const worked = await prisma.sourcePost.findMany({ where: { processingStartedAt: { gte: startedAt } }, select: { id: true } });
  for (const id of new Set([...runPostIds, ...worked.map((p) => p.id)])) covered.set(id, true);

  const rows = await prisma.sourcePost.findMany({
    where: { id: { in: [...covered.keys()] } },
    orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
    select: {
      id: true, externalId: true, processingStatus: true, text: true, noteTweetText: true,
      extractions: { where: { promptVersion, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 },
      linkDecisions: { select: { faultIndex: true, outcome: true, outageId: true, reason: true } },
      outagePosts: { select: { faultIndex: true, outageId: true, effect: true } },
    },
  });

  const posts = [];
  let expectedFaults = 0;
  let disposed = 0;
  for (const x of rows) {
    const e = x.extractions[0];
    const isReply = /^\s*@\w+/.test(x.noteTweetText || x.text || '');
    const items = e?.result ? faultItems({ ...e, result: e.result }) : [];
    const expectedIndices = isReply ? [0] : items.map((i) => i.faultIndex);
    const verdict = e || isReply ? checkPostDispositions({ expectedIndices, decisions: x.linkDecisions, outagePosts: x.outagePosts }) : { problems: [], excluded: [] };
    expectedFaults += expectedIndices.length;
    disposed += expectedIndices.filter((i) => x.linkDecisions.some((d) => d.faultIndex === i)).length;
    for (const p of verdict.problems) problems.push({ kind: 'DISPOSITION', postId: x.id, externalId: x.externalId, message: p });
    const linkable = e?.result && ['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE'].includes(e.result.relevance);
    if (linkable) for (const d of verdict.excluded) problems.push({ kind: 'FAULT_LEFT_OUT', postId: x.id, externalId: x.externalId, message: `fault ${d.faultIndex} produced no outage (${d.reason})` });
    if (e?.result) for (const op of x.outagePosts) if (effectReadingMismatch(op.effect, e.result)) problems.push({ kind: 'STALE_EFFECT', postId: x.id, externalId: x.externalId, message: `the outage entry for fault ${op.faultIndex} was built from a different reading than the current one` });
    if (['NEEDS_REVIEW', 'PROCESSING_ERROR', 'UNPROCESSED'].includes(x.processingStatus)) problems.push({ kind: 'POST_STATE', postId: x.id, externalId: x.externalId, message: `the post is ${x.processingStatus}` });
    posts.push({
      postId: x.id, externalId: x.externalId, status: x.processingStatus,
      revision: e?.result ? readingRevision(e.result) : null, // which reading the dispositions below were made from
      faults: expectedIndices.map((i) => ({ faultIndex: i, outcome: x.linkDecisions.find((d) => d.faultIndex === i)?.outcome ?? null, outageId: x.linkDecisions.find((d) => d.faultIndex === i)?.outageId ?? null })),
    });
  }

  const changedOutageIds = [...new Set(rows.flatMap((x) => x.outagePosts.map((o) => o.outageId)))];
  // whole-picture contradictions in the outages this cycle touched
  const touched = await prisma.outage.findMany({ where: { id: { in: changedOutageIds } }, include: { localities: true } });
  for (const o of touched) {
    if (['ACTIVE', 'PARTIALLY_RESTORED'].includes(o.status) && o.localities.length && o.localities.every((l) => l.restored)) problems.push({ kind: 'CONTRADICTION', outageId: o.id, message: `"${o.title}" is live but every suburb is restored` });
    if (o.status === 'RESTORED' && o.localities.some((l) => !l.restored)) problems.push({ kind: 'CONTRADICTION', outageId: o.id, message: `"${o.title}" is restored but a suburb is not` });
  }

  const stuck = stuckProcessing(await prisma.sourcePost.findMany({ where: { processingStatus: 'PROCESSING' }, select: { processingStatus: true, processingStartedAt: true } }), now.getTime());
  const needsReview = rows.filter((x) => x.processingStatus === 'NEEDS_REVIEW').length;
  const ingestionIncomplete = Boolean(ingestion?.incomplete) || ingestion?.status === 'RATE_LIMITED' || ingestion?.status === 'FAILED';
  const status = decideStatus({ error, incomplete, backlog, ingestionIncomplete, stuck: stuck.length, problems: problems.length, needsReview });
  const summary = {
    posts: rows.length, expectedFaults, faultsWithDisposition: disposed, outagesChanged: changedOutageIds.length,
    problems: problems.length, needsReview, backlog, stuck: stuck.length, incomplete, ingestionIncomplete,
    tally, ...(error ? { error: String(error).slice(0, 300) } : {}),
  };
  const saved = await prisma.cycleQuality.create({
    data: { trigger, status, startedAt, finishedAt: now, ingestionRunId, summary, problems: problems.slice(0, 200), posts, changedOutageIds },
  });
  return { id: saved.id, status, summary, problems };
}
