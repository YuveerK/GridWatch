import test from 'node:test';
import assert from 'node:assert/strict';
import { assetSymbol, groupByBand, isAdministrativeEdge, linkLabel, networkParams, positionLabel, safeSourceUrl } from '../src/lib/network.js';

test('view changes preserve selection, service and directory paging in shareable URLs', () => {
  const initial = new URLSearchParams('service=water&asset=reservoir&view=connections&offset=30');
  const next = networkParams(initial, { view: 'map' });
  assert.equal(next.get('asset'), 'reservoir');
  assert.equal(next.get('service'), 'water');
  assert.equal(next.get('offset'), '30');
  assert.equal(initial.get('view'), 'connections');
  const suburb = networkParams(next, { asset: null, suburb: 'fourways' });
  assert.equal(suburb.has('asset'), false);
  assert.equal(suburb.get('suburb'), 'fourways');
});

test('position provenance never treats absent metadata as a known position', () => {
  assert.equal(positionLabel({}), 'Position unknown');
  assert.equal(positionLabel({ lat: 0, lon: 0 }), 'Position source unknown');
  assert.equal(positionLabel({ lat: -26, lon: 28, derived: true }), 'Estimated from associated suburbs');
  assert.equal(positionLabel({ lat: -26, lon: 28, derived: false }), 'Recorded asset coordinates');
});

test('source links accept web URLs only', () => {
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('data:text/html,hello'), null);
  assert.equal(safeSourceUrl('https://example.org/report.pdf'), 'https://example.org/report.pdf');
});

test('major equipment roles are distinguishable without colour', () => {
  assert.equal(new Set(['SDC', 'RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'SUBSTATION', 'FEEDER'].map(assetSymbol)).size, 6);
});

test('electricity groups from substations down to street equipment', () => {
  const groups = groupByBand([
    { type: 'TRANSFORMER', name: 'street' },
    { type: 'SUBSTATION', name: 'station' },
    { type: 'FEEDER', name: 'circuit' },
  ], 'ELECTRICITY');
  assert.deepEqual(groups.map((group) => group.id), ['station', 'circuit', 'street']);
  assert.deepEqual(groups.map((group) => group.items[0].name), ['station', 'circuit', 'street']);
});

test('water groups from bulk supply down to local routes', () => {
  const groups = groupByBand([
    { type: 'PUMP_STATION' },
    { type: 'RESERVOIR' },
    { type: 'TREATMENT_WORKS' },
    { type: 'DIRECT_FEED' },
  ], 'WATER');
  assert.deepEqual(groups.map((group) => group.id), ['bulk', 'storage', 'pump', 'route']);
});

test('service centres stay off the supply path and recorded equipment links stay on it', () => {
  assert.equal(isAdministrativeEdge({ asset: { type: 'SDC' }, relationType: 'LEGACY_PARENT' }), true);
  assert.equal(isAdministrativeEdge({ asset: { type: 'WATER_TOWER' }, relationType: 'PART_OF' }), true);
  assert.equal(isAdministrativeEdge({ asset: { type: 'DISTRIBUTOR' }, relationType: 'LEGACY_PARENT' }), false);
  assert.equal(isAdministrativeEdge({ asset: { type: 'RESERVOIR' }, relationType: 'SUPPLIES' }), false);
  assert.equal(linkLabel('LEGACY_PARENT'), 'Recorded link');
  assert.equal(linkLabel('SUPPLIES'), 'Supplies');
  assert.equal(linkLabel('PART_OF'), 'Not a supply route');
});
