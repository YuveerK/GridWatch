import { buffer } from '@turf/buffer';
import { concave } from '@turf/concave';
import { union } from '@turf/union';

const collection = (features) => ({ type: 'FeatureCollection', features });

/** A visual estimate from suburb centres, never an official supply boundary.
 * Keep distant groups separate; retain small circles for isolated/collinear points.
 */
export function estimateCoverage(places) {
  const unique = new Map();
  for (const { lon, lat } of places) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) >= 85) continue;
    unique.set(`${lon},${lat}`, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } });
  }
  const points = [...unique.values()];
  if (!points.length) return null;
  const hull = points.length >= 3 ? concave(collection(points), { maxEdge: 4, units: 'kilometers' }) : null;
  const buffered = buffer(collection(hull ? [hull, ...points] : points), 0.7, { units: 'kilometers', steps: 12 });
  const feature = buffered.features.length === 1 ? buffered.features[0] : union(buffered);
  if (!feature) return null;
  feature.properties = { estimated: true };
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const coords = polygons.flat(2);
  const bounds = [
    [Math.min(...coords.map((p) => p[0])), Math.min(...coords.map((p) => p[1]))],
    [Math.max(...coords.map((p) => p[0])), Math.max(...coords.map((p) => p[1]))],
  ];
  return { data: collection([feature]), bounds, count: points.length };
}
