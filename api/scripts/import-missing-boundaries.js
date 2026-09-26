// Outlines for Johannesburg suburbs that have none, from the City of Johannesburg's own GIS, matched by township name:
//   1. Proclaimed and SG-approved townships (map3/MapServer/15), the source of the existing outlines
//   2. 2011 census townships (Census/MapServer/86), for townships layer 1 lacks (e.g. Lawley Ext 2)
// A compound name ("Lawley Ext 1 & 2") gets the union of its parts, and only when every part is found. Suburbs that
// already have an outline are never touched. By default only suburbs GridWatch uses (named in an incident, or linked to
// equipment) are filled, since those are the ones a map can show; --all also fills the rest of the city.
//
//   node scripts/import-missing-boundaries.js                 preview: what would be filled, and what has no match
//   node scripts/import-missing-boundaries.js --apply         write, after saving a snapshot to data/backups/
//   node scripts/import-missing-boundaries.js --all [--apply] every Johannesburg suburb without one, used or not
//   node scripts/import-missing-boundaries.js --restore <file>  put back exactly what the snapshot recorded
//   node scripts/import-missing-boundaries.js --fix-mismatch [--apply]
//       suburbs whose dot is outside their own outline: judged against the City's outline for that exact name, either
//       the outline is replaced (it was wrong) or the dot moves inside it (the geocoded position was wrong). A suburb
//       with no official outline is only reported, never guessed at. See planRepair in src/lib/boundary-match.js.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { indexByName, matchBoundary, planRepair } from '../src/lib/boundary-match.js';
import { interiorPoint } from '../src/lib/geo-contains.js';

const AGS = 'https://ags.joburg.org.za/server/rest/services';
const SOURCES = [
  { label: 'coj-township', url: `${AGS}/map3/MapServer/15`, name: 'TOWN_NAME_DESC' },
  { label: 'coj-census-2011', url: `${AGS}/Census/MapServer/86`, name: 'SP_NAME' },
];
const backups = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');
const apply = process.argv.includes('--apply');
const everyone = process.argv.includes('--all');
const fixMismatch = process.argv.includes('--fix-mismatch');
const restoreAt = process.argv.indexOf('--restore');

if (restoreAt > -1) {
  const file = process.argv[restoreAt + 1];
  const rows = JSON.parse(readFileSync(file, 'utf8')).rows;
  for (const r of rows) {
    await prisma.locality.update({ where: { id: r.id }, data: { boundary: r.before.boundary ?? undefined, lat: r.before.lat, lon: r.before.lon, geoSource: r.before.geoSource } });
    if (r.before.boundary == null) await prisma.$executeRaw`UPDATE "Locality" SET "boundary" = NULL WHERE "id" = ${r.id}`;
  }
  console.log(`Restored ${rows.length} suburb(s) from ${file}`);
  await prisma.$disconnect();
  process.exit(0);
}

/** Every feature of one layer as GeoJSON, simplified to about a metre (the stored outlines are simplified too). */
async function features(url) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const q = `${url}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&maxAllowableOffset=0.00001&geometryPrecision=6&f=geojson&resultOffset=${offset}&resultRecordCount=1000`;
    const payload = await (await fetch(q)).json();
    if (payload.error) throw new Error(`${url}: ${JSON.stringify(payload.error)}`);
    rows.push(...(payload.features ?? []));
    if ((payload.features ?? []).length < 1000) break;
  }
  return rows;
}

const sources = [];
for (const s of SOURCES) {
  const rows = await features(s.url);
  sources.push({ label: s.label, index: indexByName(rows, (f) => f.properties?.[s.name]) });
  console.log(`${s.label}: ${rows.length} polygons`);
}

const jhb = await prisma.municipality.findUnique({ where: { code: 'JOHANNESBURG' } });
if (!jhb) throw new Error('Johannesburg municipality is not seeded');
const inScope = (await prisma.locality.findMany({
  where: {
    active: true,
    OR: [{ Region: { Municipality: { code: 'JOHANNESBURG' } } }, { municipalityId: jhb.id }],
    ...(everyone ? {} : { AND: [{ OR: [{ outages: { some: {} } }, { nodes: { some: {} } }] }] }),
  },
  select: { id: true, canonicalName: true, boundary: true, lat: true, lon: true, geoSource: true },
}));

/** Save what is about to change, so --restore can put it back exactly. */
function saveSnapshot(kind, localities) {
  mkdirSync(backups, { recursive: true });
  const file = path.join(backups, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), rows: localities.map((l) => ({ id: l.id, name: l.canonicalName, before: { boundary: l.boundary, lat: l.lat, lon: l.lon, geoSource: l.geoSource } })) }, null, 1));
  return file;
}

if (fixMismatch) {
  const plans = inScope
    .filter((l) => l.boundary && l.lat != null && l.lon != null)
    .map((l) => ({ locality: l, ...planRepair(l, matchBoundary(l.canonicalName, sources)) }))
    .filter((p) => p.action !== 'none');
  const km = (p) => Math.hypot((p.point[0] - p.locality.lon) * 100, (p.point[1] - p.locality.lat) * 111).toFixed(1);
  console.log(`
Suburbs whose dot is outside their own outline: ${plans.length}`);
  for (const p of plans) {
    const what = p.action === 'outline' ? 'official outline around the dot added to it' : p.action === 'dot' ? `dot moves ${km(p)} km into the official outline` : 'no official outline to judge by: left alone';
    console.log(`  ${p.locality.canonicalName.padEnd(30)} ${what}`);
  }
  const fixes = plans.filter((p) => p.action !== 'unsure');
  if (!apply) {
    console.log(`
Preview only. Run again with --fix-mismatch --apply to repair ${fixes.length}.`);
    await prisma.$disconnect();
    process.exit(0);
  }
  const file = saveSnapshot('mismatch', fixes.map((p) => p.locality));
  for (const p of fixes) {
    await prisma.locality.update({
      where: { id: p.locality.id },
      data: { boundary: p.boundary, ...(p.action === 'dot' ? { lon: p.point[0], lat: p.point[1], geoSource: 'coj-outline-interior' } : {}) },
    });
  }
  console.log(`
Repaired ${fixes.length}. Snapshot: ${file}`);
  console.log(`Undo with: node scripts/import-missing-boundaries.js --restore "${file}"`);
  await prisma.$disconnect();
  process.exit(0);
}

const candidates = inScope.filter((l) => l.boundary == null);

const matched = [];
const unmatched = [];
for (const l of candidates) {
  const m = matchBoundary(l.canonicalName, sources);
  if (m) matched.push({ locality: l, ...m });
  else unmatched.push(l.canonicalName);
}

console.log(`\nJohannesburg suburbs without an outline${everyone ? '' : ' that GridWatch uses'}: ${candidates.length}`);
console.log(`  would fill ${matched.length}:`);
for (const m of matched) console.log(`    ${m.locality.canonicalName.padEnd(34)} <- ${m.sources.join(' + ')}${m.locality.lat == null ? '  (also gets a position)' : ''}`);
console.log(`  no official match for ${unmatched.length}: ${unmatched.sort().join(', ')}`);

if (!apply) {
  console.log('\nPreview only. Run again with --apply to write.');
  await prisma.$disconnect();
  process.exit(0);
}

const snapshot = saveSnapshot('boundaries', matched.map((m) => m.locality));
for (const m of matched) {
  const centre = m.locality.lat == null || m.locality.lon == null ? interiorPoint(m.boundary) : null;
  await prisma.locality.update({
    where: { id: m.locality.id },
    data: { boundary: m.boundary, ...(centre ? { lon: centre[0], lat: centre[1], geoSource: m.sources[0] } : {}) },
  });
}
console.log(`\nFilled ${matched.length} outline(s). Snapshot: ${snapshot}`);
console.log(`Undo with: node scripts/import-missing-boundaries.js --restore "${snapshot}"`);
await prisma.$disconnect();
