import { describe, expect, it, vi } from 'vitest';
import { createScheduler } from '../../src/lib/scheduler.js';

describe('elapsed-interval scheduler', () => {
  it('waits the interval after each tick finishes, so ticks never overlap and long intervals work', async () => {
    vi.useFakeTimers();
    const log = [];
    const s = createScheduler({
      intervalMs: 90 * 60_000, // 90 minutes: not expressible as a cron minute step
      tick: async () => {
        log.push('start');
        await new Promise((r) => setTimeout(r, 5 * 60_000));
        log.push('end');
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(log).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(log).toEqual(['start', 'end']);
    await vi.advanceTimersByTimeAsync(90 * 60_000); // the next starts 90 min after the last ENDED
    expect(log).toEqual(['start', 'end', 'start']);
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000); // let the running tick finish
    await stopping;
    vi.useRealTimers();
  });

  it('a failing tick is reported and the schedule carries on', async () => {
    vi.useFakeTimers();
    const errors = [];
    let n = 0;
    const s = createScheduler({ intervalMs: 1000, tick: async () => { n += 1; throw new Error(`boom ${n}`); }, onError: (e) => errors.push(e.message) });
    s.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(errors).toEqual(['boom 1', 'boom 2']);
    await s.stop();
    vi.useRealTimers();
  });

  it('stop cancels the pending tick and waits for one in progress', async () => {
    vi.useFakeTimers();
    let finished = false;
    const s = createScheduler({ intervalMs: 1000, tick: async () => { await new Promise((r) => setTimeout(r, 500)); finished = true; } });
    s.start();
    await vi.advanceTimersByTimeAsync(1100);
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(600);
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.active).toBe(false);
    vi.useRealTimers();
  });
});
