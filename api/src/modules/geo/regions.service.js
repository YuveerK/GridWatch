import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../db/prisma.js';
import { localityKey } from '../../lib/normalize.js';
import { stripExt } from './geocode.service.js';

// Suburb outlines for the map: Stats SA Census 2011 sub-places (see scripts/build-boundaries.js), matched to our suburbs.
// Order of trust: same name, name without extension numbers, whole main place ("Roodepoort"), then "the outline the pin falls in".

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'boundaries', 'jhb-subplaces.json');
const RANK = { exact: 0, stripped: 1, main: 2, near: 3 };

/** Ray casting on one ring. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A polygon is [outerRing, ...holes]. */
export const pointInPolygon = (pt, polygon) => inRing(pt, polygon[0]) && !polygon.slice(1).some((h) => inRing(pt, h));
export const pointInSubplace = (pt, sub) => {
  const [minX, minY, maxX, maxY] = sub.bbox;
  if (pt[0] < minX || pt[0] > maxX || pt[1] < minY || pt[1] > maxY) return false;
  return sub.polygons.some((poly) => pointInPolygon(pt, poly));
};

/** Lookup tables over a list of sub-places ({ code, sp, mp, bbox, center, polygons }). */
export function buildIndex(subplaces) {
  const byName = new Map();
  const byMain = new Map();
  const push = (map, key, sub) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(sub);
  };
  for (const s of subplaces) {
    push(byName, localityKey(s.sp), s);
    push(byMain, localityKey(s.mp), s);
  }
  return { subplaces, byName, byMain };
}

/** Which outline(s) belong to one of our suburbs? Returns { kind, subs } or null. */
export function matchLocality(loc, index) {
  const names = [loc.normalizedName, localityKey(loc.canonicalName)];
  for (const k of names) if (index.byName.has(k)) return { kind: 'exact', subs: index.byName.get(k) };
  const stripped = localityKey(stripExt(loc.canonicalName));
  if (index.byName.has(stripped)) return { kind: 'stripped', subs: index.byName.get(stripped) };
  for (const k of [...names, stripped]) if (index.byMain.has(k)) return { kind: 'main', subs: index.byMain.get(k) };
  if (loc.lat != null && loc.lon != null) {
    const hit = index.subplaces.find((s) => pointInSubplace([loc.lon, loc.lat], s));
    if (hit) return { kind: 'near', subs: [hit] };
  }
  return null;
}

/**
 * One outline per suburb, as a GeoJSON feature. A sub-place is given to the best match only
 * (an exact name beats "the outline the pin happens to fall in"), so shapes never draw twice.
 */
export function assignRegions(localities, index) {
  const claims = localities
    .map((loc) => ({ loc, m: matchLocality(loc, index) }))
    .filter((c) => c.m)
    .sort((a, b) => RANK[a.m.kind] - RANK[b.m.kind]);
  const taken = new Set();
  const features = [];
  for (const { loc, m } of claims) {
    const subs = m.subs.filter((s) => !taken.has(s.code));
    if (!subs.length) continue;
    subs.forEach((s) => taken.add(s.code));
    const cx = subs.reduce((t, x) => t + x.center[0], 0) / subs.length;
    const cy = subs.reduce((t, x) => t + x.center[1], 0) / subs.length;
    features.push({
      type: 'Feature',
      properties: { id: loc.id, name: loc.canonicalName, kind: m.kind, center: [Number(cx.toFixed(5)), Number(cy.toFixed(5))] },
      geometry: { type: 'MultiPolygon', coordinates: subs.flatMap((s) => s.polygons) },
    });
  }
  return features;
}

let cached = null;
let index = null;
function loadIndex() {
  if (!index) index = buildIndex(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  return index;
}

/** GeoJSON of suburb outlines for every suburb in use. Cached for a few minutes; the outlines themselves never change. */
export async function regionsGeoJson() {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.data;
  const localities = await prisma.locality.findMany({
    where: { OR: [{ outages: { some: {} } }, { nodes: { some: {} } }] },
    select: { id: true, canonicalName: true, normalizedName: true, lat: true, lon: true },
  });
  const data = { type: 'FeatureCollection', features: assignRegions(localities, loadIndex()) };
  cached = { at: Date.now(), data };
  return data;
}
