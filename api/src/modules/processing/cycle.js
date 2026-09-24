import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { ingestNewPosts } from '../ingestion/ingestion.service.js';
import { sweepStaleOutages } from '../outages/linker.service.js';
import { placeLocalities } from '../geo/geocode.service.js';
import { withLease, PIPELINE } from '../coordination/lease.js';
import { faultItems, processPending, retryImageFailures, retryTieBreaks } from './processor.service.js';
import { assessCycle, beginCycleQuality, coveredPostIds, failCycleQuality } from './quality.js';
import { runReview } from '../review/review.service.js';

function friendly(err) {
  const m = String(err?.message ?? err);
  if (/^Couldn't reach X/.test(m)) return m; // already written for the operator
  if (/BEARER_TOKEN/i.test(m)) return "The server isn't connected to X yet (X_API_BEARER_TOKEN is missing).";
  if (/GEMINI|API key/i.test(m)) return "The server couldn't reach the AI service. Check the Gemini key and credit.";
  return `Something went wrong: ${m.slice(0, 160)}`;
}

/**
 * One "fetch the latest posts, read them, update outages" cycle, shared by the scheduler and the manual button.
 * Single-flight (never two at once), with a cooldown on manual runs and a cap on posts read per run, because
 * every run spends money at X and at the AI provider. Dependencies are injected so it can be tested without either.
 */
export function createCycle({ ingest, process, retry, review, sweep, place, counts, assess, begin, failRecord, lease = async (fn) => ({ acquired: true, value: await fn(undefined) }), now = () => Date.now(), cooldownMs = 90_000, maxPosts = 200 }) {
  let state = { state: 'idle', trigger: null, step: null, startedAt: null, finishedAt: null, progress: null, found: null, result: null, error: null };
  let lastManualAt = 0;
  let current = Promise.resolve();

  const snapshot = () => ({ ...state, cooldownUntil: lastManualAt ? lastManualAt + cooldownMs : null, now: now() });

  async function work(ctx) {
    const before = await counts();
    const cycleStart = new Date(now());
    // the cycle's quality record exists from the moment it starts (RUNNING): a cycle that dies still leaves a visible trace
    const stageFailures = [];
    let qualityId = null;
    try {
      qualityId = (await begin?.({ trigger: state.trigger, startedAt: cycleStart }))?.id ?? null;
      state.qualityId = qualityId;
    } catch (err) {
      stageFailures.push('record');
      logger.warn({ err: err?.message }, 'could not create the cycle record');
    }
    const ing = await ingest({ ctx });
    if (ing?.skipped) throw Object.assign(new Error('Another fetch is already in progress.'), { spent: false });
    const fetched = (ing?.postsFetched ?? 0) > 0;
    // Once X has answered with posts, money may have been spent: a later failure must not reopen the cooldown.
    const fail = (message) => Object.assign(new Error(message), { spent: fetched });
    if (ing?.status === 'RATE_LIMITED') throw fail('X is limiting requests right now. Try again in a few minutes.');
    if (ing?.status === 'FAILED') throw fail(ing.error || 'Fetching from X failed. Try again shortly.');
    state.step = 'reading';
    state.found = ing?.postsInserted ?? 0;
    let proc;
    try {
      proc = await process({
        limit: maxPosts,
        ctx,
        onStart: (total) => { state.progress = { done: 0, total }; },
        onPost: (_res, done, total) => { state.progress = { done, total }; },
      });
    } catch (err) {
      err.spent = true; // the AI may have been paid for before this failed
      throw err;
    }
    // posts held back only because a picture would not download are read again (bounded; never holds up or breaks a fetch)
    let retried = { tried: 0, fixed: 0 };
    try {
      retried = (await retry?.({ ctx })) ?? retried;
    } catch (err) {
      logger.warn({ err: err?.message }, 'retrying posts with missing pictures failed; will try again next run');
    }
    // suspicious changes are queued for a person (and, if switched on, the independent check); this never changes an outage
    let reviewed = { flagged: 0, opened: 0, verified: 0 };
    let reviewFailed = false;
    try {
      reviewed = (await review?.({ startedAt: cycleStart, ingestionRunId: ing?.runId ?? null })) ?? reviewed;
    } catch (err) {
      reviewFailed = true; // required stage: reported, and its posts are looked at again next cycle
      stageFailures.push('review');
      logger.warn({ err: err?.message }, 'the review pass failed; its posts are looked at again next run');
    }
    state.step = 'tidying';
    // pin any suburbs learned from these posts on the map; capped and failure-proof, it can never hold up or break a fetch
    let placed = 0;
    try {
      const g = await place?.();
      placed = (g?.osm ?? 0) + (g?.geocoder ?? 0);
    } catch (err) {
      logger.warn({ err: err?.message }, 'placing new suburbs on the map failed; will retry next fetch');
    }
    // a required stage that did not run is reported, never passed over as success. An account whose fetch failed or was rate
    // limited this cycle is reported the same way - even though the overall fetch still succeeded (another account came
    // through), its own new posts and backlog are held back until it recovers (see processPending's incompleteAccounts).
    const incomplete = [...stageFailures, ...(ing?.failedAccounts ?? []).map((f) => `ingest:${f.displayName} (${f.status.toLowerCase()})`)];
    const swept = await sweep({ ctx });
    if (swept?.skipped) {
      incomplete.push('sweep');
      logger.warn('the cleanup sweep was skipped during a refresh');
    }
    const after = await counts();
    // The saved quality result: the deterministic checks over exactly the posts this cycle covered. Assessing can never break a cycle.
    // If assessing itself fails that is an explicit outcome: the record is closed FAILED (if the database allows) and the result says so.
    let quality = null;
    try {
      quality = await assess?.({ trigger: state.trigger, startedAt: cycleStart, qualityId, ingestionRunId: ing?.runId ?? null, ingestion: ing, tally: proc?.tally ?? {}, backlog: proc?.remaining ?? 0, incomplete });
    } catch (err) {
      stageFailures.push('assess');
      logger.warn({ err: err?.message }, 'could not assess the quality of this cycle');
      let closed = null;
      try {
        closed = await failRecord?.({ qualityId, error: err?.message ?? 'failed', stage: 'assess' });
      } catch (e) {
        logger.warn({ err: e?.message }, 'could not close the cycle record either');
      }
      quality = { id: closed?.id ?? qualityId, status: 'FAILED', problems: [], error: String(err?.message ?? err).slice(0, 200) };
    }
    const tally = proc?.tally ?? {};
    const failed = (tally.ERROR ?? 0) + (tally.FAILED ?? 0); // could not be processed; retried on the next run
    const needsReview = tally.NEEDS_REVIEW ?? 0;
    const attempted = proc?.attempted ?? proc?.total ?? 0;
    return {
      checked: ing?.postsFetched ?? 0,
      newPosts: ing?.postsInserted ?? 0,
      // fetch side: X pages are capped separately from how many posts are read per run
      fetchIncomplete: Boolean(ing?.incomplete),
      processed: attempted,
      succeeded: Math.max(0, attempted - failed - needsReview),
      failed,
      needsReview,
      backlog: proc?.remaining ?? 0,
      // backlog held back for chronological ordering (an account's fetch interval isn't complete yet), not actually stuck
      held: proc?.held ?? 0,
      newOutages: Math.max(0, after.outages - before.outages),
      updates: Math.max(0, after.outagePosts - before.outagePosts),
      capped: (proc?.remaining ?? 0) > 0,
      placed,
      retriedPictures: retried.tried,
      incomplete,
      stageFailures,
      degraded: stageFailures.length > 0,
      reviewOpened: reviewed.opened,
      quality: quality ? { id: quality.id, status: quality.status, problems: quality.problems.length, ...(quality.error ? { error: quality.error } : {}) } : null,
    };
  }

  async function run(trigger) {
    state = { state: 'running', trigger, step: 'fetching', startedAt: now(), finishedAt: null, progress: null, found: null, result: null, error: null };
    try {
      const outcome = await lease((ctx) => work(ctx));
      if (!outcome.acquired) throw Object.assign(new Error('Another fetch is already in progress.'), { spent: false });
      state = { ...state, state: 'done', step: null, finishedAt: now(), result: outcome.value };
    } catch (err) {
      logger.error({ err: err?.message, trigger }, 'refresh cycle failed');
      try {
        await assess?.({ trigger, startedAt: new Date(state.startedAt ?? now()), qualityId: state.qualityId ?? null, error: err?.message ?? 'failed' });
      } catch (e) {
        logger.warn({ err: e?.message }, 'could not record the failed cycle');
      }
      state = { ...state, state: 'error', step: null, finishedAt: now(), error: friendly(err) };
      // a failed attempt that spent nothing lets the operator retry straight away; one that may have been billed does not
      if (trigger === 'manual' && err?.spent !== true) lastManualAt = 0;
    }
  }

  return {
    status: snapshot,
    /** Fire-and-forget. Returns immediately with why it did or didn't start. */
    start(trigger = 'manual') {
      if (state.state === 'running') return { started: false, reason: 'running', ...snapshot() };
      if (trigger === 'manual') {
        const wait = lastManualAt + cooldownMs - now();
        if (wait > 0) return { started: false, reason: 'cooldown', retryAfterMs: wait, ...snapshot() };
        lastManualAt = now();
      }
      current = run(trigger);
      return { started: true, ...snapshot() };
    },
    /** Await a run (scheduler). Skips quietly when one is already going. */
    async runNow(trigger = 'scheduler') {
      if (state.state === 'running') return snapshot();
      current = run(trigger);
      await current;
      return snapshot();
    },
    whenIdle: () => current,
  };
}

/** The cleanup stage of a refresh: it runs under the refresh's own lease (its signature is (now, { ctx }), not ({ ctx })). */
export const sweepStage = ({ ctx } = {}) => sweepStaleOutages(new Date(), { ctx });

/**
 * The review stage. Besides this cycle's posts it re-covers the posts of any earlier cycle whose review pass failed (its record says
 * 'review' was incomplete and not yet retried), so a skipped pass is never lost.
 */
export async function reviewStage({ startedAt, ingestionRunId }, db = prisma) {
  const pending = (await db.cycleQuality.findMany({ where: { status: { in: ['INCOMPLETE', 'FAILED'] } }, orderBy: { finishedAt: 'desc' }, take: 20, select: { id: true, summary: true, posts: true } })).filter((r) => r.summary?.incomplete?.includes('review') && !r.summary?.reviewRetriedAt);
  const carried = pending.flatMap((r) => (Array.isArray(r.posts) ? r.posts.map((p) => p.postId) : []));
  const covered = await coveredPostIds(db, { startedAt, ingestionRunId });
  const out = await runReview({ prisma: db, postIds: [...new Set([...covered, ...carried])] });
  for (const r of pending) await db.cycleQuality.update({ where: { id: r.id }, data: { summary: { ...r.summary, reviewRetriedAt: new Date().toISOString() } } });
  return out;
}

export const cycle = createCycle({
  ingest: ingestNewPosts,
  process: processPending,
  retry: async ({ ctx }) => {
    const pictures = await retryImageFailures({ ctx });
    const tieBreaks = await retryTieBreaks({ ctx });
    return { tried: pictures.tried + tieBreaks.tried, fixed: pictures.fixed + tieBreaks.fixed, pictures, tieBreaks };
  },
  review: reviewStage,
  begin: ({ trigger, startedAt }) => beginCycleQuality({ prisma, trigger, startedAt }),
  failRecord: (args) => failCycleQuality({ prisma, ...args }),
  assess: (args) => assessCycle({ prisma, faultItems, promptVersion: env.AI_PROMPT_VERSION, ...args }),
  lease: (fn) => withLease(PIPELINE, fn),
  sweep: sweepStage,
  place: () => placeLocalities({ max: 8, budgetMs: 20_000 }),
  counts: async () => ({ outages: await prisma.outage.count(), outagePosts: await prisma.outagePost.count() }),
  cooldownMs: env.REFRESH_COOLDOWN_SECONDS * 1000,
  maxPosts: env.REFRESH_MAX_POSTS,
});
