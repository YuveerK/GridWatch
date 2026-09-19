// Build the suburb outlines the map draws, from Stats SA's Census 2011 sub-place boundaries (free public data).
//   1. download Subplace.zip from https://github.com/j-norwood-young/SA-Maps (it is stored with Git LFS:
//      https://media.githubusercontent.com/media/j-norwood-young/SA-Maps/master/Subplace.zip) and unzip it
//   2. node scripts/build-boundaries.js path/to/SP_SA_2011.shp
// Keeps the City of Johannesburg only and simplifies the shapes (about 15 m) so the whole set stays around 1 MB.
// Output: data/boundaries/jhb-subplaces.json. Credit on the map: Statistics South Africa, Census 2011.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shapefile from 'shapefile';

const shp = process.argv[2];
if (!shp) {
  console.error('Usage: node scripts/build-boundaries.js path/to/SP_SA_2011.shp');
  process.exit(1);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'boundaries', 'jhb-subplaces.json');
const TOLERANCE = 0.00015; // degrees, about 15 m
const round = (n) => Math.round(n * 1e5) / 1e5;

/** Douglas-Peucker line simplification. */
function simplify(points, tol) {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const sqTol = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let idx = -1;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > max) [max, idx] = [d, i];
    }
    if (max > sqTol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const cleanRing = (ring) => {
  const s = simplify(ring, TOLERANCE).map(([x, y]) => [round(x), round(y)]);
  return s.length >= 4 ? s : null;
};

const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}

const src = await shapefile.open(shp, undefined, { encoding: 'utf-8' });
const out = [];
for (let r = await src.read(); !r.done; r = await src.read()) {
  const p = r.value.properties;
  if (p.MN_MDB_C !== 'JHB' || !r.value.geometry) continue;
  const polys = polygonsOf(r.value.geometry)
    .map((poly) => poly.map(cleanRing).filter(Boolean))
    .filter((poly) => poly.length && poly[0]);
  if (!polys.length) continue;
  // bounding box and a label point (centre of the biggest part), for fast lookups and names
  let big = polys[0];
  for (const poly of polys) if (Math.abs(ringArea(poly[0])) > Math.abs(ringArea(big[0]))) big = poly;
  const xs = polys.flatMap((poly) => poly[0].map((c) => c[0]));
  const ys = polys.flatMap((poly) => poly[0].map((c) => c[1]));
  const bx = big[0].map((c) => c[0]);
  const by = big[0].map((c) => c[1]);
  out.push({
    code: p.SP_CODE,
    sp: p.SP_NAME,
    mp: p.MP_NAME,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(round),
    center: [round((Math.min(...bx) + Math.max(...bx)) / 2), round((Math.min(...by) + Math.max(...by)) / 2)],
    polygons: polys,
  });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${out.length} Johannesburg sub-places -> ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
