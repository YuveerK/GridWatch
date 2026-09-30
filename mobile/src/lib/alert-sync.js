import { createSyncQueue } from './sync-queue.js';

/** Identity of the preferences a successful sync has acknowledged. */
export function preferenceKey(following, quiet) {
  const ids = (following ?? []).map((item) => item?.id).filter(Boolean).join('\0');
  return `${ids}|${quiet?.from ?? ''}|${quiet?.to ?? ''}`;
}

/**
 * One queue for startup, resume, retry, follow, unfollow, and quiet hours.
 * Each job reads the latest desired preferences when it starts, and again before
 * it is allowed to count as acknowledged. A timed-out job stays pending and is
 * reconciled again when the abandoned request settles.
 */
export function createPreferenceReconciler({ readDesired, sync, timeoutMs = 20000, queue = createSyncQueue() }) {
  let acknowledged = null;

  const run = (ask) => queue.run(async () => {
    const desired = readDesired();
    const started = preferenceKey(desired.following, desired.quiet);
    if (!desired.token && (desired.following ?? []).length === 0 && !ask) {
      return { obsolete: false, pending: false, skipped: true };
    }
    let abandoned = false;
    const stillCurrent = () => !abandoned && preferenceKey(readDesired().following, readDesired().quiet) === started;
    const work = Promise.resolve().then(() => sync(desired.following, desired.quiet, ask, { stillCurrent }));
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const raced = await Promise.race([
      work.then((result) => ({ timedOut: false, result })).catch(() => ({ timedOut: false, result: { status: 'failed' } })),
      timeout,
    ]);
    clearTimeout(timer);
    if (raced.timedOut) {
      abandoned = true;
      work.then(() => {
        if (preferenceKey(readDesired().following, readDesired().quiet) !== started) run(false);
      }).catch(() => run(false));
      return { obsolete: false, pending: true, status: 'failed', abandoned: true };
    }
    const latest = preferenceKey(readDesired().following, readDesired().quiet);
    if (latest !== started || raced.result?.obsolete) return { obsolete: true, pending: true };
    if (raced.result?.status === 'enabled') acknowledged = started;
    else acknowledged = null;
    return { ...raced.result, obsolete: false, pending: raced.result?.status !== 'enabled' };
  });

  return {
    run,
    isPending() {
      const desired = readDesired();
      return acknowledged !== preferenceKey(desired.following, desired.quiet);
    },
  };
}
