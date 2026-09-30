import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAreaResult, nextAreaCache } from '../src/lib/area-cache.js';
import { createPreferenceReconciler, preferenceKey } from '../src/lib/alert-sync.js';
import { frameForPlaces, placesBounds } from '../src/lib/geo.js';
import { appendAllowed } from '../src/lib/outage-list.js';
import { createSyncQueue } from '../src/lib/sync-queue.js';
import { savedAgeLabel } from '../src/lib/time.js';

const savedAt = Date.now() - 86_400_000;

test('saved status keeps its original age', () => {
  assert.equal(savedAgeLabel(null), 'Saved, age unknown');
  assert.equal(savedAgeLabel(savedAt, savedAt + 86_400_000), 'Saved 1 day ago');
  const previous = nextAreaCache(null, {
    power: { ok: true, rows: [{ id: 'p' }] },
    water: { ok: true, rows: [{ id: 'w' }] },
  });
  previous.power.savedAt = savedAt;
  previous.water.savedAt = savedAt + 1000;
  const next = applyAreaResult(previous, 'water', { ok: false });
  assert.equal(next.power.savedAt, savedAt);
  assert.equal(next.power.stale, false);
  assert.equal(next.water.savedAt, savedAt + 1000);
  assert.equal(next.water.stale, true);
  assert.equal(savedAgeLabel(next.water.savedAt, savedAt + 86_400_000), 'Saved 1 day ago');
});

test('show more waits until a first-page reload, including refresh, has finished', () => {
  assert.equal(appendAllowed({ reload: false, paging: false }), true);
  assert.equal(appendAllowed({ reload: true, paging: false }), false);
  assert.equal(appendAllowed({ reload: false, paging: true }), false);
});

test('map bounds follow the drawn shape, and a single point does not become an empty fit', () => {
  const polygon = placesBounds([{
    places: [{
      lon: 28,
      lat: -26,
      boundary: { type: 'Polygon', coordinates: [[[27, -27], [30, -27], [30, -25], [27, -25], [27, -27]]] },
    }],
  }]);
  assert.deepEqual(polygon, [27, -27, 30, -25]);
  const multi = placesBounds([{
    places: [{
      lon: 28,
      lat: -26,
      boundary: { type: 'MultiPolygon', coordinates: [[[[18, -34], [19, -34], [19, -33], [18, -33], [18, -34]]]] },
    }],
  }]);
  assert.equal(multi[0], 18);
  assert.equal(multi[2], 28);
  const point = frameForPlaces([{ places: [{ lon: 28.1, lat: -26.2 }] }]);
  assert.equal(point.kind, 'center');
  assert.equal(point.zoom, 13);
  assert.deepEqual(point.center, [28.1, -26.2]);
  const spread = frameForPlaces([{ places: [{ lon: 27, lat: -26 }, { lon: 29, lat: -25 }] }]);
  assert.equal(spread.kind, 'fit');
  assert.deepEqual(spread.bounds, [27, -26, 29, -25]);
});

test('a slow startup sync cannot restore a suburb removed by a newer edit', async () => {
  let desired = { following: [{ id: 'removed-suburb' }], quiet: { from: null, to: null }, token: 'token' };
  let release;
  let started = false;
  let server = ['untouched'];
  const sync = (following, _quiet, _ask, hooks) => new Promise((resolve) => {
    const finish = () => {
      if (hooks?.stillCurrent && !hooks.stillCurrent()) {
        resolve({ status: 'failed', obsolete: true });
        return;
      }
      server = following.map((item) => item.id);
      resolve({ status: 'enabled' });
    };
    if (!started) {
      started = true;
      release = finish;
      return;
    }
    finish();
  });
  const reconciler = createPreferenceReconciler({
    readDesired: () => desired,
    sync,
    timeoutMs: 5000,
    queue: createSyncQueue(),
  });
  const startup = reconciler.run(false);
  while (!release) await Promise.resolve();
  desired = { following: [], quiet: { from: null, to: null }, token: 'token' };
  const removal = reconciler.run(false);
  release();
  const first = await startup;
  const second = await removal;
  assert.equal(first.obsolete, true);
  assert.deepEqual(server, []);
  assert.equal(second.status, 'enabled');
  assert.equal(second.pending, false);
  assert.equal(preferenceKey([], { from: null, to: null }), preferenceKey(desired.following, desired.quiet));
});

test('a failed or unavailable sync stays pending, and a timeout does not report success', async () => {
  const desired = { following: [{ id: 'a' }], quiet: { from: null, to: null }, token: 'token' };
  const failed = createPreferenceReconciler({
    readDesired: () => desired,
    sync: async () => ({ status: 'unavailable' }),
    queue: createSyncQueue(),
  });
  const unavailable = await failed.run(false);
  assert.equal(unavailable.pending, true);
  assert.equal(unavailable.status, 'unavailable');

  let release;
  const hung = createPreferenceReconciler({
    readDesired: () => desired,
    sync: () => new Promise((resolve) => { release = resolve; }),
    timeoutMs: 20,
    queue: createSyncQueue(),
  });
  const timed = await hung.run(false);
  assert.equal(timed.abandoned, true);
  assert.equal(timed.pending, true);
  assert.notEqual(timed.status, 'enabled');
  release({ status: 'enabled' });
  await new Promise((resolve) => setTimeout(resolve, 30));
});
