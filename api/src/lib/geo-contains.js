function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonContains(polygon, lon, lat) {
  if (!polygon?.length || !ringContains(polygon[0], lon, lat)) return false;
  return !polygon.slice(1).some((hole) => ringContains(hole, lon, lat));
}

/** True when a GeoJSON Polygon or MultiPolygon contains a WGS84 point. */
export function geometryContains(geometry, lon, lat) {
  if (!geometry || !Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (geometry.type === 'Polygon') return polygonContains(geometry.coordinates, lon, lat);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => polygonContains(polygon, lon, lat));
  return false;
}

const ringArea = (ring) => Math.abs(ring.reduce((sum, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;

/**
 * A point guaranteed to lie inside a Polygon/MultiPolygon, near the middle of its largest piece: where a suburb's dot
 * belongs. The average of the corners can fall outside an L- or U-shaped suburb, so when it does, the nearest point of
 * a grid over the piece that is inside wins. Returns [lon, lat] or null.
 */
export function interiorPoint(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const largest = polygons.filter((p) => p?.[0]?.length).sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
  if (!largest) return null;
  const piece = { type: 'Polygon', coordinates: largest };
  const ring = largest[0];
  const centre = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  if (geometryContains(piece, centre[0], centre[1])) return centre;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best = null;
  for (let i = 1; i < 40; i++) {
    for (let j = 1; j < 40; j++) {
      const p = [x0 + ((x1 - x0) * i) / 40, y0 + ((y1 - y0) * j) / 40];
      if (!geometryContains(piece, p[0], p[1])) continue;
      const d = Math.hypot(p[0] - centre[0], p[1] - centre[1]);
      if (!best || d < best.d) best = { p, d };
    }
  }
  return best?.p ?? ring[0];
}

/** Average of the outer ring, good enough to pin a depot label. */
export function geometryCentre(geometry) {
  const ring = geometry?.type === 'Polygon' ? geometry.coordinates?.[0] : geometry?.type === 'MultiPolygon' ? geometry.coordinates?.[0]?.[0] : null;
  if (!ring?.length) return null;
  const lon = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
  const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  return [lon, lat];
}
