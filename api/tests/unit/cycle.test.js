import { describe, expect, it } from 'vitest';
import { createCycle } from '../../src/modules/processing/cycle.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function make(overrides = {}) {
  let t = 1_000_000;
  const calls = { ingest: 0, process: 0, sweep: 0 };
  let outages = 10;
  let posts = 100;
  const cycle = createCycle({
    now: () => t,
    cooldownMs: 60_000,
    maxPosts: 50,
    counts: async () => ({ outages, outagePosts: posts }),
    ingest: async () => {
      calls.ingest++;
      return { status: 'SUCCEEDED', postsFetched: 12, postsInserted: 9 };
    },
    process: async ({ onPost }) => {
      calls.process++;
      onPost({}, 1, 9);
      outages += 2;
      posts += 7;
      return { total: 9 };
    },
    sweep: async () => {
      calls.sweep++;
    },
    ...overrides,
  });
  return { cycle, calls, advance: (ms) => (t += ms) };
}

describe('refresh cycle', () => {
  it('fetches, reads, tidies and reports what changed', async () => {
    const { cycle, calls } = make();
    expect(cycle.start('manual').started).toBe(true);
    await cycle.whenIdle();
    const s = cycle.status();
    expect(s.state).toBe('done');
    expect(s.result).toMatchObject({ newPosts: 9, processed: 9, newOutages: 2, updates: 7, failed: 0 });
    expect(calls).toEqual({ ingest: 1, process: 1, sweep: 1 });
  });

  it('reports posts that could not be processed so they are not silently lost', async () => {
    const { cycle } = make({ process: async ({ onPost }) => (onPost({}, 1, 2), { total: 2, tally: { LINKED: 1, ERROR: 1 } }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().result).toMatchObject({ processed: 2, failed: 1 });
  });

  it('pins new suburbs after reading, and a failure there never breaks the fetch', async () => {
    const ok = make({ place: async () => ({ osm: 2, geocoder: 1 }) });
    ok.cycle.start('manual');
    await ok.cycle.whenIdle();
    expect(ok.cycle.status()).toMatchObject({ state: 'done', result: { placed: 3 } });

    const broken = make({ place: async () => { throw new Error('nominatim down'); } });
    broken.cycle.start('manual');
    await broken.cycle.whenIdle();
    expect(broken.cycle.status()).toMatchObject({ state: 'done', result: { placed: 0, newPosts: 9 } });
    expect(broken.calls.sweep).toBe(1);
  });

  it('shows the clear message when the internet drops', async () => {
    const msg = "Couldn't reach X. Check your internet connection and try again.";
    const { cycle } = make({ ingest: async () => ({ status: 'FAILED', error: msg }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status()).toMatchObject({ state: 'error', error: msg });
  });

  it('never runs two cycles at once', async () => {
    const gate = deferred();
    const { cycle, calls } = make({ ingest: async () => (await gate.promise, { status: 'SUCCEEDED' }) });
    expect(cycle.start('manual').started).toBe(true);
    const second = cycle.start('manual');
    expect(second).toMatchObject({ started: false, reason: 'running' });
    expect((await cycle.runNow('scheduler')).state).toBe('running');
    gate.resolve();
    await cycle.whenIdle();
    expect(calls.process).toBe(1);
  });

  it('enforces a cooldown on manual runs but not on the scheduler', async () => {
    const { cycle, advance } = make();
    cycle.start('manual');
    await cycle.whenIdle();
    const again = cycle.start('manual');
    expect(again).toMatchObject({ started: false, reason: 'cooldown' });
    expect(again.retryAfterMs).toBeGreaterThan(0);
    await cycle.runNow('scheduler');
    expect(cycle.status().trigger).toBe('scheduler');
    advance(61_000);
    expect(cycle.start('manual').started).toBe(true);
    await cycle.whenIdle();
  });

  it('reports a friendly error when X is not connected', async () => {
    const { cycle } = make({ ingest: async () => { throw new Error('X_API_BEARER_TOKEN is not set'); } });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().state).toBe('error');
    expect(cycle.status().error).toMatch(/isn't connected to X/);
  });

  it('turns a rate limit into a clear message and does not read posts', async () => {
    const { cycle, calls } = make({ ingest: async () => ({ status: 'RATE_LIMITED' }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().error).toMatch(/limiting requests/);
    expect(calls.process).toBe(0);
  });

  it('flags when the per-run cap left work behind, and does not when the cap was hit exactly', async () => {
    const left = make({ process: async () => ({ total: 50, attempted: 50, remaining: 7 }) });
    left.cycle.start('manual');
    await left.cycle.whenIdle();
    expect(left.cycle.status().result).toMatchObject({ capped: true, backlog: 7 });
    const exact = make({ process: async () => ({ total: 50, attempted: 50, remaining: 0 }) });
    exact.cycle.start('manual');
    await exact.cycle.whenIdle();
    expect(exact.cycle.status().result).toMatchObject({ capped: false, backlog: 0 });
  });

  it('counts failed extractions and review work instead of reporting a clean refresh', async () => {
    const { cycle } = make({ process: async () => ({ total: 6, attempted: 6, remaining: 0, tally: { LINKED: 2, FAILED: 3, NEEDS_REVIEW: 1 } }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().result).toMatchObject({ processed: 6, succeeded: 2, failed: 3, needsReview: 1 });
  });

  it('keeps the cooldown when a later step fails after posts were paid for', async () => {
    const { cycle } = make({ process: async () => { throw new Error('database went away'); } });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().state).toBe('error');
    expect(cycle.start('manual')).toMatchObject({ started: false, reason: 'cooldown' });
  });

  it('reports an incomplete fetch and runs everything inside the lease it is given', async () => {
    const held = [];
    const { cycle } = make({
      lease: async (fn) => ({ acquired: true, value: await fn({ tag: 'ctx' }) }),
      ingest: async ({ ctx }) => { held.push(ctx?.tag); return { status: 'SUCCEEDED', postsFetched: 1, postsInserted: 1, incomplete: true }; },
      process: async ({ ctx }) => { held.push(ctx?.tag); return { total: 0, attempted: 0, remaining: 0, tally: {} }; },
      sweep: async ({ ctx }) => { held.push(ctx?.tag); },
    });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(held).toEqual(['ctx', 'ctx', 'ctx']);
    expect(cycle.status().result.fetchIncomplete).toBe(true);
  });

  it('a busy pipeline is reported, and costs nothing so it can be retried at once', async () => {
    const { cycle } = make({ lease: async () => ({ acquired: false }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().error).toMatch(/already in progress/);
    expect(cycle.start('manual').started).toBe(true);
  });

  it('passes the real reason through when the fetch step fails', async () => {
    const { cycle } = make({ ingest: async () => ({ status: 'FAILED', error: 'X_API_BEARER_TOKEN is not set' }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().error).toMatch(/isn't connected to X/);
  });

  it('lets the operator retry immediately after a failed attempt, but not after a successful one', async () => {
    let fail = true;
    const { cycle } = make({ ingest: async () => { if (fail) throw new Error('boom'); return { status: 'SUCCEEDED', postsInserted: 1 }; } });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().state).toBe('error');
    fail = false;
    expect(cycle.start('manual').started).toBe(true);
    await cycle.whenIdle();
    expect(cycle.start('manual')).toMatchObject({ started: false, reason: 'cooldown' });
  });

  it('reports how many posts will be read before the first one is finished, so the UI can show progress', async () => {
    const gate = deferred();
    const { cycle } = make({
      ingest: async () => ({ status: 'SUCCEEDED', postsFetched: 3, postsInserted: 3 }),
      process: async ({ onStart, onPost }) => { onStart(3); await gate.promise; onPost({}, 1, 3); return { total: 3 }; },
    });
    cycle.start('manual');
    await new Promise((r) => setTimeout(r, 5));
    expect(cycle.status()).toMatchObject({ state: 'running', step: 'reading', found: 3, progress: { done: 0, total: 3 } });
    gate.resolve();
    await cycle.whenIdle();
  });
});

describe('a required stage that did not run is not reported as a clean success (E07)', () => {
  it('a skipped sweep is listed as incomplete in the result', async () => {
    const { cycle } = make({ sweep: async () => ({ skipped: true }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status()).toMatchObject({ state: 'done', result: { incomplete: ['sweep'] } });
  });
  it('a sweep that ran leaves nothing incomplete', async () => {
    const { cycle } = make({ sweep: async () => ({ stale: 0, closed: 0 }) });
    cycle.start('manual');
    await cycle.whenIdle();
    expect(cycle.status().result.incomplete).toEqual([]);
  });
});
