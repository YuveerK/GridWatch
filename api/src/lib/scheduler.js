/**
 * Runs `tick` again a fixed time AFTER the previous one finished (an elapsed interval, not a wall-clock cron pattern), so
 * any interval from a minute to a day is honoured exactly, ticks never overlap, and a slow tick just delays the next.
 * A failing tick is reported through `onError` and never stops the schedule. `stop()` cancels the pending timer and
 * resolves once a running tick has finished, for a graceful shutdown.
 */
export function createScheduler({ intervalMs, tick, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, firstDelayMs = intervalMs }) {
  let timer = null;
  let running = null;
  let stopped = true;
  let nextAt = null; // when the pending tick is due (ms since epoch), or null when none is waiting

  const schedule = (delay) => {
    if (stopped) return;
    nextAt = Date.now() + delay;
    timer = setTimer(async () => {
      timer = null;
      nextAt = null; // running now
      running = (async () => {
        try {
          await tick();
        } catch (err) {
          onError(err);
        }
      })();
      await running;
      running = null;
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(firstDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      nextAt = null;
      await running;
    },
    get nextAt() {
      return nextAt;
    },
    get active() {
      return !stopped;
    },
  };
}
