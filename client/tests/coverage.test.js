import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCoverage } from '../src/lib/coverage.js';

const point = (lon, lat = -26) => ({ lon, lat });
const polygons = (coverage) => {
  const geometry = coverage.data.features[0].geometry;
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
};
function contains(coverage, { lon, lat }) {
  return polygons(coverage).some(([ring]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i];
      const [px, py] = ring[j];
      if ((y > lat) !== (py > lat) && lon < (px - x) * (lat - y) / (py - y) + x) inside = !inside;
    }
    return inside;
  });
}

test('empty or unusable geography has no estimated coverage', () => {
  assert.equal(estimateCoverage([]), null);
  assert.equal(estimateCoverage([point(null), point(NaN), point(181), point(28, Infinity)]), null);
});

test('one suburb or duplicate centres produce a bounded area', () => {
  const coverage = estimateCoverage([point(28), point(28)]);
  assert.equal(coverage.count, 1);
  assert.equal(coverage.data.features[0].properties.estimated, true);
  assert.ok(contains(coverage, point(28)));
  assert.ok(!contains(coverage, point(28.1)));
  assert.ok(coverage.bounds[0][0] < 28 && coverage.bounds[1][0] > 28);
});

test('distant suburbs stay separate instead of shading the land between them', () => {
  const coverage = estimateCoverage([point(28), point(28.3)]);
  assert.equal(polygons(coverage).length, 2);
  assert.ok(!contains(coverage, point(28.15)));
});

test('nearby clusters form coverage while isolated suburbs remain visible', () => {
  const places = [point(28), point(28.02), point(28.01, -26.02), point(28.4)];
  const coverage = estimateCoverage(places);
  for (const p of places) assert.ok(contains(coverage, p));
  assert.ok(contains(coverage, point(28.01, -26.006)));
  assert.ok(!contains(coverage, point(28.2)));
  for (const polygon of polygons(coverage)) {
    for (const ring of polygon) {
      assert.deepEqual(ring[0], ring.at(-1));
      for (const [lon, lat] of ring) {
        assert.ok(lon >= coverage.bounds[0][0] && lon <= coverage.bounds[1][0]);
        assert.ok(lat >= coverage.bounds[0][1] && lat <= coverage.bounds[1][1]);
      }
    }
  }
});

test('collinear points still produce usable coverage without a hull', () => {
  const places = [point(28), point(28.01), point(28.02)];
  const coverage = estimateCoverage(places);
  for (const p of places) assert.ok(contains(coverage, p));
});
