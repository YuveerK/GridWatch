import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { ingestNewPosts } from '../ingestion/ingestion.service.js';
import { sweepStaleOutages } from '../outages/linker.service.js';
import { placeLocalities } from '../geo/geocode.service.js';
import { withLease, PIPELINE } from '../coordination/lease.js';
import { processPending, retryImageFailures } from './processor.service.js';

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
export function createCycle({ ingest, process, retry, sweep, place, counts, lease = async (fn) => ({ acquired: true, value: await fn(undefined) }), now = () => Date.now(), cooldownMs = 90_000, maxPosts = 200 }) {
  let state = { state: 'idle', trigger: null, step: null, startedAt: null, finishedAt: null, progress: null, found: null, result: null, error: null };
  let lastManualAt = 0;
  let current = Promise.resolve();

  const snapshot = () => ({ ...state, cooldownUntil: lastManualAt ? lastManualAt + cooldownMs : null, now: now() });

  async function work(ctx) {
    const before = await counts();
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
    state.step = 'tidying';
    // pin any suburbs learned from these posts on the map; capped and failure-proof, it can never hold up or break a fetch
    let placed = 0;
    try {
      const g = await place?.();
      placed = (g?.osm ?? 0) + (g?.geocoder ?? 0);
    } catch (err) {
      logger.warn({ err: err?.message }, 'placing new suburbs on the map failed; will retry next fetch');
    }
    await sweep({ ctx });
    const after = await counts();
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
      newOutages: Math.max(0, after.outages - before.outages),
      updates: Math.max(0, after.outagePosts - before.outagePosts),
      capped: (proc?.remaining ?? 0) > 0,
      placed,
      retriedPictures: retried.tried,
    };
  }

  async function run(trigger) {
    state = { state: 'running', trigger, step: 'fetching', startedAt: now(), finishedAt: null, progress: null, found: null, result: null, error: null };
    try {
      const outcome = await lease(work);
      if (!outcome.acquired) throw Object.assign(new Error('Another fetch is already in progress.'), { spent: false });
      state = { ...state, state: 'done', step: null, finishedAt: now(), result: outcome.value };
    } catch (err) {
      logger.error({ err: err?.message, trigger }, 'refresh cycle failed');
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

export const cycle = createCycle({
  ingest: ingestNewPosts,
  process: processPending,
  retry: retryImageFailures,
  lease: (fn) => withLease(PIPELINE, fn),
  sweep: sweepStaleOutages,
  place: () => placeLocalities({ max: 8, budgetMs: 20_000 }),
  counts: async () => ({ outages: await prisma.outage.count(), outagePosts: await prisma.outagePost.count() }),
  cooldownMs: env.REFRESH_COOLDOWN_SECONDS * 1000,
  maxPosts: env.REFRESH_MAX_POSTS,
});
