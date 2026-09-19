import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { ingestNewPosts } from '../ingestion/ingestion.service.js';
import { sweepStaleOutages } from '../outages/linker.service.js';
import { processPending } from './processor.service.js';

function friendly(err) {
  const m = String(err?.message ?? err);
  if (/BEARER_TOKEN/i.test(m)) return "The server isn't connected to X yet (X_API_BEARER_TOKEN is missing).";
  if (/GEMINI|API key/i.test(m)) return "The server couldn't reach the AI service. Check the Gemini key and credit.";
  return `Something went wrong: ${m.slice(0, 160)}`;
}

/**
 * One "fetch the latest posts, read them, update outages" cycle, shared by the scheduler and the manual button.
 * Single-flight (never two at once), with a cooldown on manual runs and a cap on posts read per run, because
 * every run spends money at X and at the AI provider. Dependencies are injected so it can be tested without either.
 */
export function createCycle({ ingest, process, sweep, counts, now = () => Date.now(), cooldownMs = 90_000, maxPosts = 200 }) {
  let state = { state: 'idle', trigger: null, step: null, startedAt: null, finishedAt: null, progress: null, found: null, result: null, error: null };
  let lastManualAt = 0;
  let current = Promise.resolve();

  const snapshot = () => ({ ...state, cooldownUntil: lastManualAt ? lastManualAt + cooldownMs : null, now: now() });

  async function run(trigger) {
    state = { state: 'running', trigger, step: 'fetching', startedAt: now(), finishedAt: null, progress: null, found: null, result: null, error: null };
    try {
      const before = await counts();
      const ing = await ingest();
      if (ing?.skipped) throw new Error('Another fetch is already in progress.');
      if (ing?.status === 'RATE_LIMITED') throw new Error('X is limiting requests right now. Try again in a few minutes.');
      if (ing?.status === 'FAILED') throw new Error(ing.error || 'Fetching from X failed. Try again shortly.');
      state.step = 'reading';
      state.found = ing?.postsInserted ?? 0;
      const proc = await process({
        limit: maxPosts,
        onStart: (total) => { state.progress = { done: 0, total }; },
        onPost: (_res, done, total) => { state.progress = { done, total }; },
      });
      state.step = 'tidying';
      await sweep();
      const after = await counts();
      state = {
        ...state,
        state: 'done',
        step: null,
        finishedAt: now(),
        result: {
          checked: ing?.postsFetched ?? 0,
          newPosts: ing?.postsInserted ?? 0,
          processed: proc?.total ?? 0,
          newOutages: Math.max(0, after.outages - before.outages),
          updates: Math.max(0, after.outagePosts - before.outagePosts),
          capped: (proc?.total ?? 0) >= maxPosts,
        },
      };
    } catch (err) {
      logger.error({ err: err?.message, trigger }, 'refresh cycle failed');
      state = { ...state, state: 'error', step: null, finishedAt: now(), error: friendly(err) };
      if (trigger === 'manual') lastManualAt = 0; // a failed attempt spent nothing, so let the operator retry straight away
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
  sweep: sweepStaleOutages,
  counts: async () => ({ outages: await prisma.outage.count(), outagePosts: await prisma.outagePost.count() }),
  cooldownMs: env.REFRESH_COOLDOWN_SECONDS * 1000,
  maxPosts: env.REFRESH_MAX_POSTS,
});
