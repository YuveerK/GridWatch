import assert from 'node:assert/strict';
import test from 'node:test';
import { areaHeadline, sortOutages } from '../src/lib/area.js';
import { areasToGeoJSON, nearestSuburb } from '../src/lib/geo.js';
import { sameService, withService } from '../src/lib/query.js';
import { placeTone, roleLabel, statusMeta } from '../src/lib/status.js';

test('water recovering, low pressure and bypass stay amber and are never labelled restored', () => {
  for (const state of ['RECOVERING', 'LOW_PRESSURE', 'BYPASS']) {
    const meta = statusMeta('ACTIVE', 'WATER', state);
    assert.equal(meta.tone, 'partial');
    assert.equal(meta.label.toLowerCase().includes('restored'), false);
    assert.equal(meta.long.toLowerCase().includes('restored'), state === 'RECOVERING');
  }
  const recovering = statusMeta('ACTIVE', 'WATER', 'RECOVERING');
  assert.equal(recovering.label, 'Recovering');
  assert.match(recovering.long, /not confirmed restored/);
});

test('a quiet water incident keeps its lifecycle label', () => {
  const meta = statusMeta('STALE', 'WATER', 'RECOVERING');
  assert.equal(meta.label, 'No recent update');
  assert.equal(meta.tone, 'idle');
});

test('electricity and explicit water restoration keep their own sentences', () => {
  assert.equal(statusMeta('ACTIVE', 'ELECTRICITY').long, 'Power is out');
  assert.equal(statusMeta('RESTORED', 'WATER').label, 'Supply restored');
  assert.equal(statusMeta('RESTORED', 'WATER').tone, 'good');
  assert.equal(roleLabel('RESTORATION', 'WATER'), 'Water supply restored');
  assert.equal(roleLabel('RESTORATION', 'ELECTRICITY'), 'Power restored');
});

test('every scoped request names the service', () => {
  assert.match(withService('/v1/outages', 'ELECTRICITY'), /service=ELECTRICITY/);
  assert.match(withService('/v1/map?limit=10', 'WATER'), /service=WATER/);
  assert.match(withService('/v1/map?limit=10', 'WATER'), /limit=10/);
  assert.throws(() => withService('/v1/outages', undefined));
});

test('a list for one service drops the other', () => {
  const rows = [
    { id: 'power', service: 'ELECTRICITY', status: 'ACTIVE' },
    { id: 'water', service: 'WATER', status: 'ACTIVE', waterState: 'RECOVERING' },
  ];
  assert.deepEqual(sameService(rows, 'ELECTRICITY').map((row) => row.id), ['power']);
  assert.deepEqual(sameService(rows, 'WATER').map((row) => row.id), ['water']);
});

test('a suburb headline uses the water operating state and never calls recovery restored', () => {
  const headline = areaHeadline([
    { status: 'ACTIVE', service: 'WATER', waterState: 'RECOVERING', lastUpdateAt: '2026-09-27T09:00:00Z' },
  ], 'WATER');
  assert.equal(headline.label, 'Recovering');
  assert.equal(headline.tone, 'partial');
  assert.equal(areaHeadline([], 'ELECTRICITY').label, 'No outage reported');
});

test('active incidents sort ahead of planned ones', () => {
  const sorted = sortOutages([
    { status: 'PLANNED', service: 'ELECTRICITY', lastUpdateAt: '2026-09-27T10:00:00Z' },
    { status: 'ACTIVE', service: 'ELECTRICITY', lastUpdateAt: '2026-09-27T08:00:00Z' },
  ]);
  assert.equal(sorted[0].status, 'ACTIVE');
});

test('map areas take the incident tone, and a restored place is green', () => {
  const collection = areasToGeoJSON([
    {
      id: 'w1',
      title: 'Tower',
      status: 'ACTIVE',
      service: 'WATER',
      waterState: 'RECOVERING',
      places: [{ name: 'Bryanston', lat: -26.1, lon: 28.0, restored: false, boundary: { type: 'Polygon', coordinates: [] } }],
    },
    {
      id: 'e1',
      title: 'Substation',
      status: 'ACTIVE',
      service: 'ELECTRICITY',
      places: [{ name: 'Rosebank', lat: -26.1, lon: 28.04, restored: true }],
    },
  ]);
  assert.equal(collection.features[0].properties.tone, 'partial');
  assert.equal(collection.features[1].properties.tone, 'good');
  assert.equal(placeTone({ status: 'ACTIVE', service: 'WATER', waterState: 'LOW_PRESSURE' }, false), 'partial');
});

test('a GPS fix only snaps to a nearby tracked suburb', () => {
  const suburbs = [
    { id: 'near', name: 'Randburg', lat: -26.09, lon: 27.98 },
    { id: 'far', name: 'Cape Town', lat: -33.9, lon: 18.4 },
  ];
  assert.equal(nearestSuburb(suburbs, -26.1, 28.0)?.id, 'near');
  assert.equal(nearestSuburb(suburbs, -33.9, 18.4)?.id, 'far');
  assert.equal(nearestSuburb([{ id: 'only-far', name: 'Durban', lat: -29.8, lon: 31.0 }], -26.2, 28.0), null);
});
