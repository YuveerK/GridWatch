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

const MIN_MUNICIPALITY_POINTS = 8; // with fewer placed suburbs we do not know the municipality's shape yet
const BOX_PADDING = { lat: 0.15, lon: 0.2 };

/** Johannesburg keeps its known, hand-tuned box; any other municipality gets one computed from its own already-placed
 * suburbs (padded), so a lookup is checked against the metro it actually belongs to, not always Johannesburg's box.
 * Returns null (skip the box check for that lookup) rather than reject good results when too little is known yet. */
export function boxForMunicipality(code, points) {
  if (code === 'JOHANNESBURG') return BOX;
  if (!points || points.length < MIN_MUNICIPALITY_POINTS) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return {
    south: Math.min(...lats) - BOX_PADDING.lat,
    north: Math.max(...lats) + BOX_PADDING.lat,
    west: Math.min(...lons) - BOX_PADDING.lon,
    east: Math.max(...lons) + BOX_PADDING.lon,
  };
}
/** A null box means "no box known yet for this municipality": never reject on that basis alone. */
export const boxAccepts = (box, lat, lon) => !box || (lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east);

async function nominatim(name, { patient, box, areaName }) {
  const boxParams = box ? `&bounded=1&viewbox=${box.west},${box.north},${box.east},${box.south}` : '';
  const q = areaName ? `${name}, ${areaName}` : name;
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za${boxParams}&q=${encodeURIComponent(q)}`;
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
  const regionSelect = { code: true, municipalityId: true, Municipality: { select: { id: true, code: true, name: true } } };
  const rows = await prisma.locality.findMany({
    where: all ? {} : { OR: [{ outages: { some: {} } }, { nodes: { some: {} } }] },
    include: { outages: { select: { outage: { select: { status: true } } } }, Region: { select: regionSelect }, Municipality: { select: { id: true, code: true, name: true } } },
  });
  // Which municipality a locality belongs to: via its Region for seeded/GIS-imported suburbs, or its own Municipality
  // column for a LEARNED one (no region). null only for a row with neither - never guessed.
  const municipalityOf = (l) => l.Region?.Municipality ?? l.Municipality ?? null;
  // where each region's already-placed suburbs are: a lookup that lands far from them is the wrong place with the right
  // name. Keyed by (municipality, region code): two municipalities can each have a region "1" or "A".
  const regionKey = (region) => (region ? `${region.municipalityId}|${region.code}` : null);
  const placed = await prisma.locality.findMany({ where: { lat: { not: null } }, select: { lat: true, lon: true, municipalityId: true, Region: { select: regionSelect } } });
  const regionPoints = new Map();
  const municipalityPoints = new Map();
  for (const p of placed) {
    const key = regionKey(p.Region);
    if (key) regionPoints.set(key, [...(regionPoints.get(key) ?? []), { lat: p.lat, lon: p.lon }]);
    const muniId = p.Region?.municipalityId ?? p.municipalityId ?? null;
    if (muniId) municipalityPoints.set(muniId, [...(municipalityPoints.get(muniId) ?? []), { lat: p.lat, lon: p.lon }]);
  }
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
  // A cache/reference lookup is scoped by municipality: OSM's suburb dump only ever covers Johannesburg (the Overpass query
  // is JHB-specific), so it's only ever offered to a Johannesburg locality. An already-placed suburb is only offered to
  // another locality of the SAME municipality - a same-named suburb in a different tracked city is not the same place, and
  // matching on name alone (before any bounding-box check even runs) was exactly how a Tshwane lookup could land on a
  // Johannesburg position of the same name.
  const byKeyByMunicipality = new Map(); // municipalityId -> Map(key -> { name, lat, lon, src })
  const bucketFor = (muniId) => {
    if (!byKeyByMunicipality.has(muniId)) byKeyByMunicipality.set(muniId, new Map());
    return byKeyByMunicipality.get(muniId);
  };
  const jhb = rows.map((l) => municipalityOf(l)).find((m) => m?.code === 'JOHANNESBURG') ?? placed.map((p) => p.Region?.Municipality).find((m) => m?.code === 'JOHANNESBURG');
  if (jhb) {
    const bucket = bucketFor(jhb.id);
    for (const p of places) {
      bucket.set(localityKey(p.name), p);
      bucket.set(localityKey(stripExt(p.name)), p);
    }
  }
  // suburbs we have already placed count too: City Power's typos ("Ferrirasdorp") then inherit the position of the right spelling
  for (const l of rows.filter((r) => r.lat != null)) {
    const muni = municipalityOf(l);
    if (!muni) continue; // no municipality context at all: never offered as a cross-check reference
    const bucket = bucketFor(muni.id);
    const entry = { name: l.canonicalName, lat: l.lat, lon: l.lon, src: 'known-suburb' };
    if (!bucket.has(l.normalizedName)) bucket.set(l.normalizedName, entry);
  }

  const fuzzy = (key, muniId) => {
    if (key.length < 10) return null; // short names are too easy to confuse with a different suburb
    const bucket = byKeyByMunicipality.get(muniId);
    if (!bucket) return null;
    let best = null;
    let bestScore = 0;
    for (const k of bucket.keys()) {
      if (k.length < 10) continue;
      const sc = similarity(key, k);
      if (sc > bestScore) [best, bestScore] = [k, sc];
    }
    return bestScore >= 0.85 ? bucket.get(best) : null;
  };

  let stop = false;
  for (const [i, l] of todo.entries()) {
    if (stop || i >= max || Date.now() - started > budgetMs) {
      out.deferred++;
      continue;
    }
    const muni = municipalityOf(l);
    const bucket = muni ? byKeyByMunicipality.get(muni.id) : null;
    const hit = bucket?.get(l.normalizedName) ?? bucket?.get(localityKey(l.canonicalName)) ?? bucket?.get(localityKey(stripExt(l.canonicalName))) ?? fuzzy(localityKey(stripExt(l.canonicalName)), muni?.id);
    const box = boxForMunicipality(muni?.code, municipalityPoints.get(muni?.id));
    let pos = hit && boxAccepts(box, hit.lat, hit.lon) ? { lat: hit.lat, lon: hit.lon, source: hit.src ?? 'osm-place' } : null;
    if (!pos) {
      try {
        // exact name first, then with run-together words split, then without a trailing "Flats"/"East"/etc. (near the main suburb, not exact)
        const name = stripExt(l.canonicalName);
        const exact = [...new Set([name, splitRunTogether(name)])];
        const parents = [...new Set(exact.map(stripDirection))].filter((b) => b && !exact.includes(b));
        const region = regionPoints.get(regionKey(l.Region));
        const town = REGION_TOWN[muni?.code]?.[l.Region?.code];
        const muniName = muni?.name ?? null;
        // the plain name (with its own municipality as area context) first; if it lands away from the rest of its region,
        // the same name with just the region's town (a self-sufficient local hint - never doubled up with the municipality name)
        const queries = [...exact.map((q) => ({ q, source: 'nominatim', areaName: muniName })), ...parents.map((q) => ({ q, source: 'nominatim-parent', areaName: muniName })), ...(town ? [...exact, ...parents].map((q) => ({ q, source: 'nominatim-town', areaName: town })) : [])];
        for (const { q, source, areaName } of queries) {
          const g = await nominatim(q, { patient, box, areaName });
          if (g && boxAccepts(box, g.lat, g.lon) && isPlausible(g, region)) {
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
