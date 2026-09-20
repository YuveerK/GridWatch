// Find suburbs whose map position looks wrong (far from the rest of their region) and look them up again with the region's
// town added ("Willowbrook, Roodepoort"). Only positions that came from the geocoder are examined.
//   node scripts/fix-placements.js                  report only: what looks wrong and where it would move
//   node scripts/fix-placements.js --apply          write the proposed positions
//   node scripts/fix-placements.js --only=<id>      just one suburb
// Nothing is changed without --apply, and a suburb that cannot be re-found in a believable place is left as it is.
import { prisma } from '../src/db/prisma.js';
import { inBox } from '../src/modules/geo/geocode.service.js';
import { REGION_TOWN, distanceKm, isPlausible } from '../src/modules/geo/plausible.js';

const apply = process.argv.includes('--apply');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'GridWatch/0.1 (suburb position check; contact via project repo)';

async function lookup(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&q=${encodeURIComponent(q)}`;
  const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
  const [hit] = await res.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

const all = await prisma.locality.findMany({ where: { lat: { not: null } }, select: { id: true, canonicalName: true, lat: true, lon: true, geoSource: true, Region: { select: { code: true } } } });
const byRegion = new Map();
for (const l of all) byRegion.set(l.Region?.code, [...(byRegion.get(l.Region?.code) ?? []), { id: l.id, lat: l.lat, lon: l.lon }]);
// the others of a region, never the suburb being judged (it would vouch for itself)
const others = (l) => (byRegion.get(l.Region?.code) ?? []).filter((p) => p.id !== l.id);

const suspects = all.filter((l) => l.Region && (only ? l.id === only : l.geoSource?.startsWith('nominatim')) && !isPlausible(l, others(l)));
console.log(`${suspects.length} suburb position(s) look wrong out of ${all.length} placed.\n`);

let fixed = 0;
for (const l of suspects) {
  const town = REGION_TOWN[l.Region?.code];
  const name = l.canonicalName.replace(/\b(ext(ension)?s?|x)\.?\s*\d*\b/gi, ' ').replace(/\s+/g, ' ').trim();
  let found = null;
  try {
    for (const q of [`${name}, ${town}`, `${name} ${town}`]) {
      const g = await lookup(q);
      await sleep(1100);
      if (g && inBox(g.lat, g.lon) && isPlausible(g, others(l))) {
        found = g;
        break;
      }
    }
  } catch (err) {
    console.log(`  ${l.canonicalName}: lookup failed (${err.message}); left as it is`);
    continue;
  }
  const from = `${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}`;
  if (!found) {
    console.log(`  ${l.canonicalName} (region ${l.Region?.code}): now ${from}. No believable position found; left as it is.`);
    continue;
  }
  console.log(`  ${l.canonicalName} (region ${l.Region?.code}): ${from} -> ${found.lat.toFixed(4)}, ${found.lon.toFixed(4)} (${distanceKm(l, found).toFixed(1)} km)`);
  if (apply) {
    await prisma.locality.updateMany({ where: { id: l.id, lat: l.lat, lon: l.lon }, data: { lat: found.lat, lon: found.lon, geoSource: 'nominatim-town' } });
    fixed++;
  }
}
console.log(apply ? `\nUpdated ${fixed}.` : '\nNothing changed. Re-run with --apply to write these.');
await prisma.$disconnect();
