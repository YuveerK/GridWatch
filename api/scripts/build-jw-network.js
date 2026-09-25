// Turn the official Johannesburg Water reservoir, tower and direct-feed tables
// into data/johannesburg-water/network.json. Pass the three markdown dumps.
//   node scripts/build-jw-network.js <reservoirs.md> <towers.md> <direct-feeds.md>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [reservoirsPath, towersPath, feedsPath] = process.argv.slice(2);
if (!reservoirsPath || !towersPath || !feedsPath) {
  console.error('usage: node scripts/build-jw-network.js <reservoirs.md> <towers.md> <direct-feeds.md>');
  process.exit(1);
}

const RESERVOIRS = 'https://www.johannesburgwater.co.za/johannesburg-water-reservoirs-3/';
const TOWERS = 'https://www.johannesburgwater.co.za/johannesburg-water-towers/';
const FEEDS = 'https://www.johannesburgwater.co.za/johannesburg-water-direct-feeds/';
const RAND_WATER = 'https://www.randwater.co.za/aboutus.php';
const SANDTON = 'https://www.johannesburgwater.co.za/sandton-systems/';
const RW_PDF = 'https://www.johannesburgwater.co.za/wp-content/uploads/2026/05/RW-planned-maintenance-to-impact-JW-systems_May2026.NS_.pdf';

function cells(line) {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

function isRule(line) {
  return /^\|\s*-+/.test(line);
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function titleCase(name) {
  const raw = name.replace(/\s+/g, ' ').trim();
  if (raw !== raw.toUpperCase()) return raw;
  return raw.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function slug(name) {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function connections(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { rwConnections: null, connectionLabel: null };
  const ids = [...text.matchAll(/\b(?:RW|JW|CBI)\s*\d+\b/gi)].map((m) => m[0].replace(/\s+/g, '').toUpperCase());
  const unique = [...new Set(ids)];
  return {
    rwConnections: unique.length ? unique : null,
    connectionLabel: unique.length ? null : text,
  };
}

function metrics(stands, capacity, aadd, storage) {
  const storageHours = parseNumber(storage);
  return {
    stands: parseNumber(stands),
    capacityKl: parseNumber(capacity),
    aaddKlDay: parseNumber(aadd),
    storageHours,
    storageNote: storage && storageHours == null ? String(storage).trim() : null,
  };
}

function parseZones(text, { columns }) {
  const zones = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|') || isRule(line)) continue;
    const c = cells(line);
    if (c[0] === 'Zone') continue;
    if (c[0]) {
      current = { zone: c[0].replace(/\s+/g, ' ').trim(), suburbs: [], ...columns(c) };
      zones.push(current);
    } else if (current) {
      const suburb = c[columns.suburbIndex];
      if (suburb) current.suburbs.push(suburb.replace(/\s+/g, ' ').trim());
    }
  }
  return zones;
}

const reservoirCols = (c) => ({ suburb: c[1], ...metrics(c[2], c[3], c[4], c[5]) });
reservoirCols.suburbIndex = 1;
const feedCols = (c) => ({ connection: c[1], suburb: c[2], ...metrics(c[3], null, c[4], null) });
feedCols.suburbIndex = 2;

const reservoirs = parseZones(readFileSync(reservoirsPath, 'utf8'), { columns: reservoirCols });
const towers = parseZones(readFileSync(towersPath, 'utf8'), { columns: reservoirCols });
const feeds = parseZones(readFileSync(feedsPath, 'utf8'), { columns: feedCols });

const towerNames = new Set(towers.map((z) => z.zone.toLowerCase()));

function assetType(zone) {
  const n = zone.toLowerCase();
  if (/\bprv\b/.test(n)) return 'PRV';
  if (/pump station/.test(n)) return 'PUMP_STATION';
  return 'DIRECT_FEED';
}

function displayName(zone, type) {
  const name = titleCase(zone);
  if (type === 'RESERVOIR' && !/reservoir/i.test(name)) return `${name} Reservoir`;
  if (type === 'WATER_TOWER' && !/tower/i.test(name)) return `${name} Tower`;
  if (type === 'DIRECT_FEED' && !/direct/i.test(name)) return `${name} Direct Feed`;
  if (type === 'PRV' && !/prv/i.test(name)) return `${name} PRV`;
  if (type === 'PUMP_STATION' && !/pump/i.test(name)) return `${name} Pump Station`;
  return name;
}

const KEEP_KEYS = [
  { type: 'RESERVOIR', re: /^illovo reservoir$/, key: 'jw:illovo-reservoir' },
  { type: 'DIRECT_FEED', re: /^linbro park direct feed$/, key: 'jw:linbro-direct' },
  { type: 'DIRECT_FEED', re: /^marlboro direct( feed)?$/, key: 'jw:marlboro-direct' },
];

const assets = [];
const assetLocalities = [];
const seen = new Set();

function addAsset(zone, type, sourceUrl, extra = {}) {
  const name = displayName(zone.zone, type);
  const kept = KEEP_KEYS.find((k) => k.type === type && k.re.test(name.toLowerCase()));
  let key = kept?.key ?? `jw:${slug(name)}`;
  if (seen.has(key)) key = `${key}-2`;
  seen.add(key);
  const conn = connections(extra.connection);
  assets.push({
    key,
    name,
    type,
    operator: 'JOHANNESBURG_WATER',
    stands: zone.stands,
    capacityKl: zone.capacityKl,
    aaddKlDay: zone.aaddKlDay,
    storageHours: zone.storageHours,
    storageNote: zone.storageNote,
    rwConnections: conn.rwConnections,
    connectionLabel: conn.connectionLabel,
    sourceUrls: [sourceUrl],
  });
  for (const localityName of zone.suburbs) {
    assetLocalities.push({ assetKey: key, localityName, relation: 'SERVES', sourceUrl });
  }
  return key;
}

for (const zone of reservoirs) addAsset(zone, 'RESERVOIR', RESERVOIRS);
for (const zone of towers) addAsset(zone, 'WATER_TOWER', TOWERS);
for (const zone of feeds) {
  if (towerNames.has(zone.zone.toLowerCase())) continue;
  addAsset(zone, assetType(zone.zone), FEEDS, { connection: zone.connection });
}

assets.unshift(
  { key: 'rw:palmiet', name: 'Palmiet', type: 'BOOSTER_STATION', operator: 'RAND_WATER', sourceUrls: [RAND_WATER] },
  { key: 'rw:eikenhof', name: 'Eikenhof', type: 'BOOSTER_STATION', operator: 'RAND_WATER', sourceUrls: [RAND_WATER] },
  { key: 'jw:sandton-system', name: 'Sandton System', type: 'WATER_SYSTEM', operator: 'JOHANNESBURG_WATER', sourceUrls: [SANDTON] },
);

const illovo = assets.find((a) => a.key === 'jw:illovo-reservoir');
const relationships = [
  { from: 'rw:palmiet', to: 'jw:sandton-system', type: 'SUPPLIES', sourceUrl: RW_PDF },
];
if (illovo) relationships.push({ from: 'jw:sandton-system', to: 'jw:illovo-reservoir', type: 'SUPPLIES', sourceUrl: SANDTON });

const network = {
  generatedAt: new Date().toISOString(),
  sources: [
    { sourceType: 'OFFICIAL_WEB', title: 'Johannesburg Water reservoirs', url: RESERVOIRS },
    { sourceType: 'OFFICIAL_WEB', title: 'Johannesburg Water towers', url: TOWERS },
    { sourceType: 'OFFICIAL_WEB', title: 'Johannesburg Water direct feeds', url: FEEDS },
    { sourceType: 'OFFICIAL_WEB', title: 'Rand Water', url: RAND_WATER },
    { sourceType: 'OFFICIAL_WEB', title: 'Sandton systems', url: SANDTON },
    { sourceType: 'OFFICIAL_DOCUMENT', title: 'Rand Water planned maintenance impact on JW systems, May 2026', url: RW_PDF },
  ],
  assets,
  assetLocalities,
  relationships,
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'data/johannesburg-water/network.json');
writeFileSync(out, JSON.stringify(network, null, 2));
const byType = {};
for (const a of assets) byType[a.type] = (byType[a.type] ?? 0) + 1;
console.log(JSON.stringify({ assets: assets.length, localities: assetLocalities.length, byType, skippedTowerRows: feeds.filter((z) => towerNames.has(z.zone.toLowerCase())).map((z) => z.zone) }, null, 2));
