// Independent audit checks of the current callback implementations.
// No device rendering, network access, or production storage writes.
// CONFIRMED REMAINING assertions intentionally describe current bugs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { migrateAreaCache, nextAreaCache } from '../../mobile/src/lib/area-cache.js';
import { keepFollowingCache, mergeUnit, unitFromRows } from '../../mobile/src/lib/following-status.js';
import { mergeOutagePage, outageQueryKey, pageStillCurrent } from '../../mobile/src/lib/outage-list.js';
import { sameService } from '../../mobile/src/lib/query.js';
import { createSyncQueue } from '../../mobile/src/lib/sync-queue.js';
import { ALERT_COPY } from '../../mobile/src/lib/alerts.js';

const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const ts = require('typescript');
const noop = () => {};
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function extract(path, environment, named = [], target = 'load') {
  const filename = fileURLToPath(new URL(`../../mobile/${path}`, import.meta.url));
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const extra = [];
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === target) expression = node.initializer.arguments[0].getText(source);
    if (ts.isFunctionDeclaration(node) && named.includes(node.name?.getText(source))) extra.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const context = vm.createContext(environment);
  const code = `${extra.join('\n')}\nglobalThis.auditTarget = ${expression ?? target};`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.auditTarget;
}

// Original R01/R02 helper fixes.
const savedAt = Date.now() - 86_400_000;
const old = nextAreaCache(null, { power: { ok: true, rows: [] }, water: { ok: true, rows: [{ id: 'water', service: 'WATER', status: 'ACTIVE' }] } });
old.power.savedAt = savedAt;
old.water.savedAt = savedAt;
const merged = nextAreaCache(old, { power: { ok: true, rows: [] }, water: { ok: false } });
assert.equal(merged.water.rows[0].id, 'water');
assert.equal(merged.water.stale, true);
assert.equal(migrateAreaCache({ power: [], water: [] }).water.state, 'unknown');
const unit = unitFromRows([{ id: 'p', service: 'ELECTRICITY', status: 'ACTIVE' }], 'ELECTRICITY', savedAt);
const remembered = mergeUnit(unit, { status: 'rejected' }, 'ELECTRICITY');
assert.equal(remembered.label, 'Outage');
assert.equal(remembered.state, 'stale');
assert.equal(keepFollowingCache([{ id: 's', power: unit }], [{ id: 's', power: { state: 'error' } }])[0].power.label, 'Outage');
console.log('FIX VERIFIED: failed service preserves a known incident; legacy empties remain unknown; Following preserves a known status.');

// Current Home callback: useful data retained, but banner uses the current clock.
{
  let bannerAt;
  let power;
  const load = extract('app/(tabs)/index.tsx', {
    request: { current: 0 }, setNote: noop, setUpdatedAt: noop,
    setPower: (value) => { power = value; }, setWater: noop,
    setCachedAt: (value) => { bannerAt = value; },
    readCache: async () => ({ data: old, savedAt }), writeCache: async () => {},
    migrateAreaCache, nextAreaCache, withTimeout: (promise) => promise,
    api: { localityOutages: async () => { throw new Error('offline'); }, sync: async () => { throw new Error('offline'); } },
  }, ['viewOf']);
  await load('s');
  assert.equal(power.savedAt, savedAt);
  assert.ok(bannerAt - savedAt >= 86_000_000);
  console.log(JSON.stringify({ remaining: 'S01', actualCachedAgeHours: Math.round((bannerAt - power.savedAt) / 3_600_000), bannerSaysSavedJustNow: true }));
}

function listLoad(initialRows) {
  let rows = initialRows;
  const pending = [];
  const environment = {
    active: { current: { key: '', seq: 0 } }, paging: { current: false }, replacing: { current: false }, rowsRef: { current: rows },
    service: 'WATER', status: { status: 'ACTIVE' }, sort: 'updated', q: '', centre: '', PAGE: 30,
    setRows: (value) => { rows = typeof value === 'function' ? value(rows) : value; },
    setTotal: noop, setCounts: noop, setLoading: noop, setLoadingMore: noop, setRefreshing: noop, setError: noop,
    mergeOutagePage, outageQueryKey, pageStillCurrent, sameService,
    api: { outages: (_service, options) => { const gate = defer(); pending.push({ ...gate, offset: options.offset }); return gate.promise; } },
  };
  return { load: extract('app/(tabs)/outages/index.tsx', environment), pending, rows: () => rows };
}

// Original R03 query replacement is guarded now.
{
  const state = listLoad([{ id: 'power', service: 'ELECTRICITY' }]);
  const first = state.load('replace');
  await state.load('append');
  assert.equal(state.pending.length, 1);
  assert.equal(state.rows().length, 0);
  state.pending[0].resolve({ total: 1, data: [{ id: 'water', service: 'WATER' }] });
  await first;
  assert.equal(state.rows()[0].service, 'WATER');
  console.log('FIX VERIFIED: replacement clears old service rows and blocks append until the new first page resolves.');
}

// Refresh still permits append under the same request sequence.
{
  const initial = Array.from({ length: 30 }, (_, i) => ({ id: `old-${i}`, service: 'WATER' }));
  const state = listLoad(initial);
  const refresh = state.load('refresh');
  const append = state.load('append');
  assert.deepEqual(state.pending.map((request) => request.offset), [0, 30]);
  state.pending[1].resolve({ total: 60, data: [{ id: 'page-2', service: 'WATER' }] });
  await append;
  assert.equal(state.rows().length, 31);
  state.pending[0].resolve({ total: 60, data: [{ id: 'fresh-page-1', service: 'WATER' }] });
  await refresh;
  assert.equal(state.rows().some((row) => row.id === 'page-2'), false);
  console.log('CONFIRMED REMAINING S02: append completes during refresh, then refresh silently discards that page.');
}

// Startup calls syncAlerts directly while edits use the queue.
{
  const startupGate = defer();
  let calls = 0;
  let serverList;
  const sync = extract('src/state/app.tsx', {
    Platform: { OS: 'ios' }, ALERT_COPY,
    Notifications: { getPermissionsAsync: async () => ({ status: 'granted' }) },
    pushToken: async () => 'token',
    api: {
      registerDevice: async () => { if (++calls === 1) await startupGate.promise; },
      replaceSubscriptions: async (_token, ids) => { serverList = ids; },
    },
  }, ['alertResult', 'syncAlerts'], 'syncAlerts');
  const startup = sync([{ id: 'removed-suburb' }], { from: null, to: null }, false);
  while (!calls) await Promise.resolve();
  const queue = createSyncQueue();
  await queue.run(() => sync([], { from: null, to: null }, false));
  assert.equal(serverList.length, 0);
  startupGate.resolve();
  await startup;
  assert.equal(serverList[0], 'removed-suburb');
  console.log('CONFIRMED REMAINING S03: unqueued startup sync restores a suburb removed by a newer queued edit.');
}

// Map callback still leaves old-service features while new data is pending.
{
  let features = [{ id: 'power', service: 'ELECTRICITY' }];
  const gate = defer();
  const load = extract('app/(tabs)/map/index.tsx', {
    generation: { current: 0 }, service: 'WATER', sameService,
    setError: noop, setLoading: noop, setChoices: noop,
    setOutages: (value) => { features = value; },
    api: { map: () => gate.promise },
  });
  const pending = load();
  assert.equal(features[0].service, 'ELECTRICITY');
  gate.resolve({ data: [{ id: 'water', service: 'WATER' }] });
  await pending;
  assert.equal(features[0].service, 'WATER');
  console.log('CONFIRMED REMAINING S04: Power map features remain available while Water is loading.');
}
