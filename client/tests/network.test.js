import test from 'node:test';
import assert from 'node:assert/strict';
import { assetSymbol, networkParams, positionLabel, safeSourceUrl } from '../src/lib/network.js';

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
