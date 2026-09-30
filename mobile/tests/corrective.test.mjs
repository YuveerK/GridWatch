import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateAreaCache, nextAreaCache } from '../src/lib/area-cache.js';
import { withTimeout } from '../src/lib/deadline.js';
import { keepFollowingCache, mergeUnit, unitFromRows } from '../src/lib/following-status.js';
import { MAP_LAYERS, placesBounds, uniqueSelections } from '../src/lib/geo.js';
import { mergeOutagePage, outageQueryKey, pageStillCurrent } from '../src/lib/outage-list.js';
import { createSyncQueue } from '../src/lib/sync-queue.js';

test('an old empty area cache is unknown, not a successful empty list', () => {
  const cache = migrateAreaCache({ power: [], water: [], updatedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(cache.version, 2);
  assert.equal(cache.power.state, 'unknown');
  assert.equal(cache.water.state, 'unknown');
  assert.deepEqual(cache.power.rows, []);
});

test('a non-empty unversioned area cache stays as a stale success', () => {
  const cache = migrateAreaCache({ power: [{ id: 'p1' }], water: [], updatedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(cache.power.state, 'ok');
  assert.equal(cache.power.stale, true);
  assert.equal(cache.power.rows.length, 1);
  assert.equal(cache.water.state, 'unknown');
});

test('a failed service keeps the last successful rows and a success replaces them', () => {
  const previous = nextAreaCache(null, {
    power: { ok: true, rows: [{ id: 'p1' }] },
    water: { ok: true, rows: [] },
    sourceAt: '2026-09-28T00:00:00.000Z',
  });
  const failed = nextAreaCache(previous, {
    power: { ok: false },
    water: { ok: true, rows: [{ id: 'w1' }] },
    sourceAt: '2026-09-28T01:00:00.000Z',
  });
  assert.equal(failed.power.state, 'ok');
  assert.equal(failed.power.stale, true);
  assert.equal(failed.power.rows[0].id, 'p1');
  assert.equal(failed.water.stale, false);
  assert.equal(failed.water.rows[0].id, 'w1');
  const unknown = nextAreaCache(migrateAreaCache({ power: [], water: [] }), {
    power: { ok: false },
    water: { ok: false },
  });
  assert.equal(unknown.power.state, 'unknown');
});

test('following keeps a remembered suburb when one service fails', () => {
  const saved = unitFromRows([{ id: 'p1', status: 'ACTIVE' }], 'ELECTRICITY', 10);
  const failed = mergeUnit(saved, { status: 'rejected', reason: new Error('offline') }, 'ELECTRICITY', 20);
  assert.equal(failed.state, 'stale');
  assert.equal(failed.label, saved.label);
  const fresh = mergeUnit(saved, { status: 'fulfilled', value: { data: [] } }, 'ELECTRICITY', 30);
  assert.equal(fresh.state, 'ok');
  const stored = keepFollowingCache(
    [{ id: 'a', name: 'A', power: saved, water: saved }],
    [{ id: 'a', name: 'A', power: { state: 'error', label: 'Unavailable' }, water: fresh }],
  );
  assert.equal(stored[0].power.state, 'stale');
  assert.equal(stored[0].water.state, 'ok');
});

test('outage pages stay bound to the query that requested them', () => {
  const power = outageQueryKey({ service: 'ELECTRICITY', status: 'ACTIVE', sort: 'updated', q: '', centre: '' });
  const water = outageQueryKey({ service: 'WATER', status: 'ACTIVE', sort: 'updated', q: '', centre: '' });
  assert.notEqual(power, water);
  const first = [{ id: 'p1' }, { id: 'p2' }];
  const appended = mergeOutagePage(first, [{ id: 'p2' }, { id: 'p3' }], false);
  assert.deepEqual(appended.map((row) => row.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(mergeOutagePage(first, [{ id: 'w1' }], true).map((row) => row.id), ['w1']);
  assert.equal(pageStillCurrent({ key: water, seq: 2 }, { key: water, seq: 2 }), true);
  assert.equal(pageStillCurrent({ key: power, seq: 1 }, { key: water, seq: 2 }), false);
});

test('map layers omit planned work and collapse polygon plus point hits', () => {
  assert.equal(MAP_LAYERS.some((layer) => layer.id === 'plan'), false);
  const choices = uniqueSelections([
    { outageId: 'o1', placeId: 's1', name: 'A' },
    { outageId: 'o1', placeId: 's1', name: 'A' },
    { outageId: 'o1', placeId: 's2', name: 'B' },
  ]);
  assert.equal(choices.length, 2);
  const bounds = placesBounds([{ places: [{ lon: 28, lat: -26 }, { lon: 29, lat: -25 }] }]);
  assert.deepEqual(bounds, [28, -26, 29, -25]);
  assert.equal(placesBounds([{ places: [] }]), null);
});

test('only the latest preference sync is applied', async () => {
  const queue = createSyncQueue();
  let started = 0;
  const older = queue.run(async () => {
    started += 1;
    return { list: 'older' };
  });
  const newer = queue.run(async () => {
    started += 1;
    return { list: 'newer' };
  });
  const first = await older;
  const second = await newer;
  assert.equal(first.obsolete, true);
  assert.equal(second.list, 'newer');
  assert.equal(started, 1);
});

test('a stalled request stops blocking the screen', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => undefined), 15), /timeout/);
});
