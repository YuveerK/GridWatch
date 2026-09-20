import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { localityKey, similarity } from '../../lib/normalize.js';

// Gives suburbs an approximate map position (a centre point) from free OpenStreetMap data:
// suburb areas first, then the Nominatim geocoder. Used by `npm run geocode` and after every fetch.

const UA = 'GridWatch/0.1 (personal outage tracker)';
export const BOX = { south: -26.5, north: -25.8, west: 27.6, east: 28.4 }; // Johannesburg metro, roughly
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'cache', 'osm-places.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const inBox = (lat, lon) => lat >= BOX.south && lat <= BOX.north && lon >= BOX.west && lon <= BOX.east;
export const stripExt = (s) => s.replace(/\b(ext(ension)?s?|x)\.?\s*\d*\b/gi, ' ').replace(/\s+/g, ' ').trim();
export const stripDirection = (s) => s.replace(/\s+(north|south|east|west|central|upper|lower|gardens?|estate|village|farm|farms|hostel|cbd|flats?|complex|towers?|mall)$/i, '').trim();

/** "OrlandoEkhaya" -> "Orlando Ekhaya": City Power often runs two words together. */
export const splitRunTogether = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');

import { REGION_TOWN, isPlausible } from './plausible.js';

class RateLimited extends Error {}

/** Suburb positions from OpenStreetMap. Downloaded at most once a month, and only when asked to (a fetch never downloads). */
export async function loadOsmPlaces({ download = false } = {}) {
  const fresh = fs.existsSync(CACHE) && Date.now() - fs.statSync(CACHE).mtimeMs < 30 * 86_400_000;
  if (fresh || (!download && fs.existsSync(CACHE))) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  if (!download) return [];
  logger.info('downloading suburb positions from OpenStreetMap (once a month)');
  const q = '[out:json][timeout:180];area["name"="City of Johannesburg Metropolitan Municipality"]["boundary"="administrative"]->.a;(node(area.a)[place~"suburb|neighbourhood|quarter|town|village|locality"];way(area.a)[place~"suburb|neighbourhood|quarter|town|village|locality"];relation(area.a)[place~"suburb|neighbourhood|quarter|town|village|locality"];relation(area.a)[boundary=administrative][admin_level~"9|10"];);out center tags;';
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(200_000) });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const els = (await res.json()).elements
    .filter((e) => e.tags?.name && (e.center || e.lat != null))
    .map((e) => ({ name: e.tags.name, lat: e.center?.lat ?? e.lat, lon: e.center?.lon ?? e.lon }));
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(els));
  return els;
}

async function nominatim(name, { patient }) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&bounded=1&viewbox=${BOX.west},${BOX.north},${BOX.east},${BOX.south}&q=${encodeURIComponent(`${name}, Johannesburg`)}`;
  let res;
  for (let attempt = 0; attempt < (patient ? 4 : 1); attempt++) {
    res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (res.status !== 429) break;
    if (patient) await sleep(8000 * (attempt + 1)); // rate limited: back off, then try again
  }
  if (res.status === 429) throw new RateLimited('Nominatim is rate limiting');
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

/**
 * Place suburbs that have no position yet. Safe to call at any time and from a fetch:
 *  - `max` and `budgetMs` cap the work, so it can never hold a fetch up; whatever is left waits for next time
 *  - a lookup that fails (network, rate limit) leaves the suburb untouched and is retried later
 *  - a suburb the sources really cannot find is marked 'none' and not retried unless `retry` is set
 * Suburbs on live outages go first.
 */
export async function placeLocalities({ all = false, retry = false, max = Infinity, budgetMs = Infinity, download = false, patient = false, onProgress } = {}) {
  const started = Date.now();
  const rows = await prisma.locality.findMany({
    where: all ? {} : { OR: [{ outages: { some: {} } }, { nodes: { some: {} } }] },
    include: { outages: { select: { outage: { select: { status: true } } } }, Region: { select: { code: true } } },
  });
  // where each region's already-placed suburbs are: a lookup that lands far from them is the wrong place with the right name
  const placed = await prisma.locality.findMany({ where: { lat: { not: null } }, select: { lat: true, lon: true, Region: { select: { code: true } } } });
  const regionPoints = new Map();
  for (const p of placed) regionPoints.set(p.Region?.code, [...(regionPoints.get(p.Region?.code) ?? []), { lat: p.lat, lon: p.lon }]);
  const isLive = (l) => l.outages.some((o) => ['ACTIVE', 'PARTIALLY_RESTORED'].includes(o.outage.status));
  const todo = rows
    .filter((l) => l.lat == null && (retry || l.geoSource !== 'none'))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.canonicalName.localeCompare(b.canonicalName));
  const out = { todo: todo.length, osm: 0, geocoder: 0, none: 0, deferred: 0 };
  if (!todo.length) return out;

  let places = [];
  try {
    places = await loadOsmPlaces({ download });
  } catch (err) {
    logger.warn({ err: err.message }, 'could not load OpenStreetMap suburb positions; using the geocoder only');
  }
  const byKey = new Map();
  for (const p of places) {
    byKey.set(localityKey(p.name), p);
    byKey.set(localityKey(stripExt(p.name)), p);
  }
  // suburbs we have already placed count too: City Power's typos ("Ferrirasdorp") then inherit the position of the right spelling
  for (const l of rows.filter((r) => r.lat != null)) {
    const entry = { name: l.canonicalName, lat: l.lat, lon: l.lon, src: 'known-suburb' };
    if (!byKey.has(l.normalizedName)) byKey.set(l.normalizedName, entry);
  }

  const keys = [...byKey.keys()].filter((k) => k.length >= 10);
  const fuzzy = (key) => {
    if (key.length < 10) return null; // short names are too easy to confuse with a different suburb
    let best = null;
    let bestScore = 0;
    for (const k of keys) {
      const sc = similarity(key, k);
      if (sc > bestScore) [best, bestScore] = [k, sc];
    }
    return bestScore >= 0.85 ? byKey.get(best) : null;
  };

  let stop = false;
  for (const [i, l] of todo.entries()) {
    if (stop || i >= max || Date.now() - started > budgetMs) {
      out.deferred++;
      continue;
    }
    const hit = byKey.get(l.normalizedName) ?? byKey.get(localityKey(l.canonicalName)) ?? byKey.get(localityKey(stripExt(l.canonicalName))) ?? fuzzy(localityKey(stripExt(l.canonicalName)));
    let pos = hit && inBox(hit.lat, hit.lon) ? { lat: hit.lat, lon: hit.lon, source: hit.src ?? 'osm-place' } : null;
    if (!pos) {
      try {
        // exact name first, then with run-together words split, then without a trailing "Flats"/"East"/etc. (near the main suburb, not exact)
        const name = stripExt(l.canonicalName);
        const exact = [...new Set([name, splitRunTogether(name)])];
        const parents = [...new Set(exact.map(stripDirection))].filter((b) => b && !exact.includes(b));
        const region = regionPoints.get(l.Region?.code);
        const town = REGION_TOWN[l.Region?.code];
        // the plain name first; if it lands away from the rest of its region, the same name with the region's town
        const queries = [...exact.map((q) => [q, 'nominatim']), ...parents.map((q) => [q, 'nominatim-parent']), ...(town ? [...exact, ...parents].map((q) => [`${q}, ${town}`, 'nominatim-town']) : [])];
        for (const [q, source] of queries) {
          const g = await nominatim(q, { patient });
          if (g && inBox(g.lat, g.lon) && isPlausible(g, region)) {
            pos = { ...g, source };
            break;
          }
          await sleep(1100);
        }
      } catch (err) {
        logger.warn({ suburb: l.canonicalName, err: err.message }, 'suburb lookup failed; will try again later');
        out.deferred++;
        if (err instanceof RateLimited) stop = true; // no point hammering a service that is saying "slow down"
        else await sleep(1100);
        continue;
      }
      await sleep(1100); // Nominatim allows one request a second
    }
    if (pos) {
      await prisma.locality.update({ where: { id: l.id }, data: { lat: pos.lat, lon: pos.lon, geoSource: pos.source } });
      out[pos.source.startsWith('nominatim') ? 'geocoder' : 'osm']++;
    } else {
      await prisma.locality.update({ where: { id: l.id }, data: { geoSource: 'none' } });
      out.none++;
    }
    onProgress?.(i + 1, todo.length);
  }
  return out;
}
