// Audit reproductions, not production tests or a native renderer.
// Extracts the actual current load callback bodies via TypeScript's AST,
// then runs them with controlled API/storage/state adapters. Assertions below
// intentionally confirm existing defects; after fixes they should fail/change.
// Run from repository root: node docs/audits/mobile-review-repros-2026-09-28.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { areaHeadline } from '../../mobile/src/lib/area.js';
import { sameService } from '../../mobile/src/lib/query.js';

const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const ts = require('typescript');
const root = new URL('../../mobile/', import.meta.url);
const noop = () => {};

function callback(path, environment, extraNames = []) {
  const filename = fileURLToPath(new URL(path, root));
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let load;
  const extra = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'load') load = node.initializer.arguments[0].getText(source);
    if (ts.isVariableDeclaration(node) && extraNames.includes(node.name.getText(source))) extra.push(`const ${node.getText(source)};`);
    if (ts.isFunctionDeclaration(node) && extraNames.includes(node.name?.getText(source))) extra.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(load, `Missing load callback: ${path}`);
  const js = ts.transpileModule(`${extra.join('\n')}\nglobalThis.auditLoad = ${load};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext(environment);
  vm.runInContext(js, context, { filename });
  return context.auditLoad;
}

// R01: failed water read is serialized as successful empty water data.
{
  let offline = false;
  let power;
  let water;
  let savedAt = null;
  let cache = { savedAt: 1, data: { power: [], water: [{ id: 'known-water', service: 'WATER', status: 'ACTIVE' }], updatedAt: null } };
  const load = callback('app/(tabs)/index.tsx', {
    request: { current: 0 },
    setNote: noop, setUpdatedAt: noop,
    setPower: (v) => { power = v; }, setWater: (v) => { water = v; },
    setCachedAt: (v) => { savedAt = v; },
    api: {
      localityOutages: async (_id, service) => {
        if (offline || service === 'WATER') throw new Error('unavailable');
        return { data: [{ id: 'power', service: 'ELECTRICITY', status: 'ACTIVE' }] };
      },
      sync: async () => ({ lastSyncAt: null }),
    },
    writeCache: async (_key, data) => { cache = { savedAt: 2, data }; },
    readCache: async () => cache,
  });
  await load('suburb');
  assert.equal(water.kind, 'error');
  assert.equal(cache.data.water.length, 0);
  offline = true;
  await load('suburb');
  assert.equal(water.kind, 'ok');
  assert.equal(areaHeadline(water.rows, 'WATER').label, 'No interruption reported');
  console.log(JSON.stringify({ finding: 'R01', cachedWaterRecords: cache.data.water.length, offlineWaterKind: water.kind, offlineWaterLabel: areaHeadline(water.rows, 'WATER').label, savedAt, powerKind: power.kind }));
}

// R02: ordinary network errors settle successfully, overwrite cache, and never
// reach the effect's catch-only cache fallback.
{
  let rows;
  let written;
  let rejected = false;
  const load = callback('app/(tabs)/following/index.tsx', {
    generation: { current: 0 },
    setRows: (v) => { rows = v; },
    api: { localityOutages: async () => { throw new Error('offline'); } },
    areaHeadline,
    writeCache: async (_key, value) => { written = value; },
  }, ['loadingUnit', 'unitFrom']);
  await load([{ id: 'suburb', name: 'Saved suburb' }]).catch(() => { rejected = true; });
  assert.equal(rejected, false);
  assert.equal(rows[0].power.state, 'error');
  assert.equal(written[0].water.state, 'error');
  console.log(JSON.stringify({ finding: 'R02', reachesCatchFallback: rejected, displayedPower: rows[0].power.label, cachedWaterState: written[0].water.state }));
}

// R03: changing to Water retains old Power rows; Show more supersedes the
// new first-page request and appends Water page 2 to Power page 1.
{
  let rows = Array.from({ length: 30 }, (_, i) => ({ id: `power-${i}`, service: 'ELECTRICITY' }));
  let resolveFirst;
  const requests = [];
  const load = callback('app/(tabs)/outages/index.tsx', {
    generation: { current: 0 }, service: 'WATER', status: { status: 'ACTIVE' }, sort: 'updated', q: '', centre: '', PAGE: 30,
    setLoading: noop, setLoadingMore: noop, setRefreshing: noop, setError: noop, setTotal: noop,
    setRows: (update) => { rows = typeof update === 'function' ? update(rows) : update; },
    sameService,
    api: { outages: (_service, opts) => {
      requests.push(opts.offset);
      if (opts.offset === 0) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ total: 60, data: [{ id: 'water-page-2', service: 'WATER' }] });
    } },
  });
  const pending = load(0);
  assert.equal(rows[0].service, 'ELECTRICITY');
  await load(rows.length);
  resolveFirst({ total: 60, data: [{ id: 'water-page-1', service: 'WATER' }] });
  await pending;
  assert.equal(rows.length, 31);
  assert.equal(rows.some((row) => row.id === 'water-page-1'), false);
  console.log(JSON.stringify({ finding: 'R03', requests, finalServices: [...new Set(rows.map((row) => row.service))], firstWaterPagePresent: false, rowCount: rows.length }));
}
