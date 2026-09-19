// Give suburbs an approximate map position (a centre point), so the map can show which areas an outage or a
// substation reaches. Free sources only: OpenStreetMap place data first, then the Nominatim geocoder.
//   npm run geocode              suburbs used by outages or equipment that have no position yet
//   npm run geocode -- --all     every suburb
//   npm run geocode -- --retry   also retry suburbs that failed before
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { localityKey } from '../src/lib/normalize.js';

const ALL = process.argv.includes('--all');
const RETRY = process.argv.includes('--retry');
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache', 'osm-places.json');
const UA = 'GridWatch/0.1 (personal outage tracker)';
const BOX = { south: -26.5, north: -25.8, west: 27.6, east: 28.4 }; // Johannesburg metro, roughly
const inBox = (lat, lon) => lat >= BOX.south && lat <= BOX.north && lon >= BOX.west && lon <= BOX.east;
const stripExt = (s) => s.replace(/\b(ext(ension)?s?|x)\.?\s*\d*\b/gi, ' ').replace(/\s+/g, ' ').trim();
const stripDirection = (s) => s.replace(/\s+(north|south|east|west|central|upper|lower|gardens?|estate|village|farm|farms|hostel|cbd)$/i, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function osmPlaces() {
  if (fs.existsSync(CACHE) && Date.now() - fs.statSync(CACHE).mtimeMs < 30 * 86_400_000) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log('Downloading suburb positions from OpenStreetMap (once a month)...');
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

async function nominatim(name) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&bounded=1&viewbox=${BOX.west},${BOX.north},${BOX.east},${BOX.south}&q=${encodeURIComponent(`${name}, Johannesburg`)}`;
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429) break;
    await sleep(8000 * (attempt + 1)); // rate limited: back off, then try again
  }
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

const places = await osmPlaces();
const byKey = new Map();
for (const p of places) {
  byKey.set(localityKey(p.name), p);
  byKey.set(localityKey(stripExt(p.name)), p);
}

const where = ALL ? {} : { OR: [{ outages: { some: {} } }, { nodes: { some: {} } }] };
const todo = (await prisma.locality.findMany({ where, orderBy: { canonicalName: 'asc' } })).filter((l) => (l.lat == null && (RETRY || l.geoSource !== 'none')));
console.log(`${todo.length} suburbs to place`);

const stats = { osm: 0, nominatim: 0, none: 0 };
for (const [i, l] of todo.entries()) {
  const hit = byKey.get(l.normalizedName) ?? byKey.get(localityKey(l.canonicalName)) ?? byKey.get(localityKey(stripExt(l.canonicalName)));
  let pos = hit && inBox(hit.lat, hit.lon) ? { lat: hit.lat, lon: hit.lon, source: 'osm-place' } : null;
  if (!pos) {
    try {
      const g = await nominatim(stripExt(l.canonicalName));
      if (g && inBox(g.lat, g.lon)) pos = { ...g, source: 'nominatim' };
      const base = stripDirection(stripExt(l.canonicalName));
      if (!pos && base && base.toLowerCase() !== stripExt(l.canonicalName).toLowerCase()) {
        await sleep(1100);
        const g2 = await nominatim(base);
        if (g2 && inBox(g2.lat, g2.lon)) pos = { ...g2, source: 'nominatim-parent' }; // near the main suburb, not exact
      }
    } catch (err) {
      console.log(`  ${l.canonicalName}: ${err.message} (left for the next run)`);
      await sleep(1100);
      continue; // a failed lookup is not "not found": leave the suburb as it was
    }
    await sleep(1100); // Nominatim allows one request a second
  }
  if (pos) {
    await prisma.locality.update({ where: { id: l.id }, data: { lat: pos.lat, lon: pos.lon, geoSource: pos.source } });
    stats[pos.source === 'osm-place' ? 'osm' : 'nominatim']++;
  } else {
    await prisma.locality.update({ where: { id: l.id }, data: { geoSource: 'none' } });
    stats.none++;
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${todo.length}`);
}
console.log(`Done. Placed from OpenStreetMap areas: ${stats.osm}, from the geocoder: ${stats.nominatim}, not found: ${stats.none}`);
await prisma.$disconnect();
