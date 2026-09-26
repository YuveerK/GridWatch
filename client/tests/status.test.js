import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATER_STATE, placeTone, progressStep, roleLabel, serviceFromParam, serviceParam, statusMeta } from '../src/lib/status.js';

test('electricity badges are unchanged and ignore any water state', () => {
  assert.equal(statusMeta('ACTIVE').label, 'Outage');
  assert.equal(statusMeta('ACTIVE', 'ELECTRICITY', 'RECOVERING').label, 'Outage');
  assert.equal(statusMeta('ACTIVE', 'ELECTRICITY', 'RECOVERING').tone, 'live');
  assert.equal(statusMeta('STALE').label, 'No recent update');
});

test('a live water incident says what customers face, not a blanket "supply interrupted"', () => {
  // Glenvista, 25 Sept: "both reservoirs supplying the system ... upward recovery trajectory" -> ACTIVE + RECOVERING
  const recovering = statusMeta('ACTIVE', 'WATER', 'RECOVERING');
  assert.equal(recovering.label, 'Recovering');
  assert.equal(recovering.tone, 'partial');
  assert.equal(statusMeta('ACTIVE', 'WATER', 'NO_SUPPLY').tone, 'live');
  assert.equal(statusMeta('ACTIVE', 'WATER', 'LOW_PRESSURE').label, 'Low pressure');
  assert.equal(statusMeta('ACTIVE', 'WATER', null).label, 'Supply interrupted');
  assert.equal(statusMeta('ACTIVE', 'WATER', 'SOMETHING_NEW').label, 'Supply interrupted');
});

test('recovery is never shown as restored: no water state is green while the incident is live', () => {
  for (const state of Object.keys(WATER_STATE)) {
    for (const status of ['ACTIVE', 'PARTIALLY_RESTORED']) assert.notEqual(statusMeta(status, 'WATER', state).tone, 'good', `${status} + ${state}`);
  }
});

test('the water state only refines live incidents; quiet, finished and planned keep their lifecycle label', () => {
  assert.equal(statusMeta('STALE', 'WATER', 'NO_SUPPLY').label, 'No recent update');
  assert.equal(statusMeta('RESTORED', 'WATER', 'NORMAL').label, 'Supply restored');
  assert.equal(statusMeta('CLOSED', 'WATER', 'RECOVERING').label, 'Closed');
  assert.equal(statusMeta('PLANNED', 'WATER', 'BYPASS').label, 'Planned');
});

test('map points: restored places are green, otherwise the incident tone', () => {
  assert.equal(placeTone({ status: 'ACTIVE', service: 'WATER', waterState: 'RECOVERING' }, false), 'partial');
  assert.equal(placeTone({ status: 'ACTIVE', service: 'WATER', waterState: 'NO_SUPPLY' }, false), 'live');
  assert.equal(placeTone({ status: 'ACTIVE', service: 'ELECTRICITY' }, true), 'good');
  assert.equal(placeTone({ status: 'PARTIALLY_RESTORED', service: 'ELECTRICITY' }, false), 'partial');
});

test('progress: a recovering water incident is past "reported" but not restored', () => {
  assert.equal(progressStep('ACTIVE', 'WATER', 'RECOVERING'), 1);
  assert.equal(progressStep('ACTIVE', 'WATER', 'NO_SUPPLY'), 0);
  assert.equal(progressStep('ACTIVE', 'ELECTRICITY'), 0);
  assert.equal(progressStep('STALE', 'WATER', 'RECOVERING'), 0);
  assert.equal(progressStep('RESTORED', 'WATER'), 2);
});

test('timeline roles use the incident service', () => {
  assert.equal(roleLabel('RESTORATION', 'WATER'), 'Water supply restored');
  assert.equal(roleLabel('RESTORATION', 'ELECTRICITY'), 'Power restored');
  assert.equal(roleLabel('SOMETHING', 'WATER'), 'Update');
});

test('the service in the address round-trips and rejects anything else', () => {
  assert.equal(serviceParam('WATER'), 'water');
  assert.equal(serviceParam('ELECTRICITY'), 'power');
  assert.equal(serviceFromParam('water'), 'WATER');
  assert.equal(serviceFromParam('Power'), 'ELECTRICITY');
  assert.equal(serviceFromParam('electricity'), 'ELECTRICITY');
  assert.equal(serviceFromParam('gas'), null);
  assert.equal(serviceFromParam(null), null);
});
