// Official City of Johannesburg service areas:
//   City Power and Eskom supply polygons -> Locality.electricitySupplier
//   City Power / Eskom depot polygons -> electricity depot nodes with a boundary
//   Johannesburg Water depot polygons and offices -> water depot nodes
//   node scripts/import-coj-service-areas.js
import { prisma } from '../src/db/prisma.js';
import { geometryCentre, geometryContains } from '../src/lib/geo-contains.js';
import { infraKey } from '../src/lib/normalize.js';

const BASE = 'https://ags.joburg.org.za/server/rest/services/CityServices/MapServer';
const LAYERS = { cityPower: 1, eskom: 2, depots: 100, waterDepots: 31, waterOffices: 33 };

async function features(layer) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${BASE}/${layer}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson&resultOffset=${offset}&resultRecordCount=1000`;
    const payload = await (await fetch(url)).json();
    if (payload.error) throw new Error(JSON.stringify(payload.error));
    rows.push(...(payload.features ?? []));
    if ((payload.features ?? []).length < 1000) break;
  }
  return rows;
}

function title(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

const municipality = await prisma.municipality.findUnique({ where: { code: 'JOHANNESBURG' } });
if (!municipality) throw new Error('Johannesburg municipality is not seeded');

const [cityPower, eskom, depots, waterDepots, waterOffices] = await Promise.all([
  features(LAYERS.cityPower), features(LAYERS.eskom), features(LAYERS.depots), features(LAYERS.waterDepots), features(LAYERS.waterOffices),
]);

async function upsertNode({ serviceType, type, name, boundary, lat, lon, metadata }) {
  const normalizedKey = infraKey(name);
  const existing = await prisma.infraNode.findFirst({
    where: { serviceType, type, normalizedKey, municipalityId: municipality.id },
  });
  const data = {
    name,
    boundary,
    lat, lon,
    geoSource: 'coj-cgis',
    lifecycle: 'CONFIRMED',
    metadata: { ...(existing?.metadata ?? {}), ...metadata },
    lastSeenAt: new Date(),
  };
  if (existing) return prisma.infraNode.update({ where: { id: existing.id }, data });
  return prisma.infraNode.create({
    data: { ...data, type, normalizedKey, serviceType, municipalityId: municipality.id, firstSeenAt: new Date() },
  });
}

const powerNodes = [];
for (const feature of depots) {
  const raw = feature.properties?.DEPOT_NAME;
  if (!raw || !feature.geometry) continue;
  const utility = String(feature.properties.UTILITYNAM ?? '').toUpperCase();
  const name = utility === 'ESKOM' ? title(raw) : title(raw);
  const centre = geometryCentre(feature.geometry);
  const node = await upsertNode({
    serviceType: 'ELECTRICITY',
    type: 'SDC',
    name,
    boundary: feature.geometry,
    lat: centre?.[1] ?? null,
    lon: centre?.[0] ?? null,
    metadata: { role: 'depot', operator: utility === 'ESKOM' ? 'ESKOM' : 'CITY_POWER', officialName: raw, sourceUrl: `${BASE}/${LAYERS.depots}` },
  });
  powerNodes.push({ node, geometry: feature.geometry });
}

const officeByName = new Map(waterOffices.map((feature) => [infraKey(feature.properties?.Depots_Off ?? ''), feature]));
const waterNodes = [];
const waterOfficesNodes = [];
const NOT_A_CATCHMENT = new Set(['head office', 'cydna lab']);
for (const feature of waterDepots) {
  const raw = feature.properties?.COMMENTS || feature.properties?.TAG_VALUE;
  if (!raw || !feature.geometry) continue;
  const office = officeByName.get(infraKey(raw.replace(/ depot$/i, ''))) ?? officeByName.get(infraKey(raw));
  const centre = geometryCentre(feature.geometry);
  const node = await upsertNode({
    serviceType: 'WATER',
    type: 'WATER_OTHER',
    name: title(raw),
    boundary: feature.geometry,
    lat: office?.properties?.Latitude ?? centre?.[1] ?? null,
    lon: office?.properties?.Longitude ?? centre?.[0] ?? null,
    metadata: {
      role: 'depot', operator: 'JOHANNESBURG_WATER', officialName: raw,
      address: office?.properties?.Office_Add ?? null, phone: office?.properties?.Contact_Nu ?? null,
      sourceUrl: `${BASE}/${LAYERS.waterDepots}`,
    },
  });
  waterNodes.push({ node, geometry: feature.geometry });
}
for (const feature of waterOffices) {
  const raw = feature.properties?.Depots_Off;
  if (!raw || waterNodes.some((row) => infraKey(row.node.name).includes(infraKey(raw)))) continue;
  const catchment = !NOT_A_CATCHMENT.has(raw.toLowerCase());
  const node = await upsertNode({
    serviceType: 'WATER',
    type: 'WATER_OTHER',
    name: `${title(raw)} Depot`,
    boundary: null,
    lat: feature.properties?.Latitude ?? null,
    lon: feature.properties?.Longitude ?? null,
    metadata: { role: catchment ? 'depot' : 'office', operator: 'JOHANNESBURG_WATER', address: feature.properties?.Office_Add ?? null, phone: feature.properties?.Contact_Nu ?? null, sourceUrl: `${BASE}/${LAYERS.waterOffices}` },
  });
  if (catchment && node.lat != null && node.lon != null) waterOfficesNodes.push(node);
}

const localities = await prisma.locality.findMany({
  where: { active: true, lat: { not: null }, lon: { not: null }, OR: [{ municipalityId: municipality.id }, { Region: { municipalityId: municipality.id } }] },
  select: { id: true, lat: true, lon: true, electricitySupplier: true },
});

let suppliers = 0;
let links = 0;
for (const locality of localities) {
  const depotHits = powerNodes.filter((row) => geometryContains(row.geometry, locality.lon, locality.lat));
  const operators = new Set(depotHits.map((row) => row.node.metadata?.operator).filter(Boolean));
  const inPower = cityPower.some((feature) => geometryContains(feature.geometry, locality.lon, locality.lat));
  const inEskom = eskom.some((feature) => geometryContains(feature.geometry, locality.lon, locality.lat));
  const supplier = operators.size === 1 && operators.has('ESKOM') ? 'Eskom'
    : operators.size === 1 && operators.has('CITY_POWER') ? 'City Power'
      : operators.size > 1 ? 'Mixed/Boundary'
        : inPower && inEskom ? 'Mixed/Boundary' : inPower ? 'City Power' : inEskom ? 'Eskom' : null;
  if (supplier && supplier !== locality.electricitySupplier) {
    await prisma.locality.update({ where: { id: locality.id }, data: { electricitySupplier: supplier } });
    suppliers += 1;
  }
  if (!waterNodes.length && waterOfficesNodes.length) {
    let nearest = waterOfficesNodes[0];
    let best = Infinity;
    for (const office of waterOfficesNodes) {
      const distance = Math.hypot((office.lon - locality.lon) * 99.7, (office.lat - locality.lat) * 111);
      if (distance < best) [nearest, best] = [office, distance];
    }
    await prisma.nodeLocality.upsert({
      where: { nodeId_localityId: { nodeId: nearest.id, localityId: locality.id } },
      create: { nodeId: nearest.id, localityId: locality.id, relationType: 'SERVES', evidenceCount: 1, lastSeenAt: new Date() },
      update: { relationType: 'SERVES', lastSeenAt: new Date() },
    });
    links += 1;
  }
  for (const row of [...powerNodes, ...waterNodes]) {
    if (!geometryContains(row.geometry, locality.lon, locality.lat)) continue;
    await prisma.nodeLocality.upsert({
      where: { nodeId_localityId: { nodeId: row.node.id, localityId: locality.id } },
      create: { nodeId: row.node.id, localityId: locality.id, relationType: 'SERVES', lastSeenAt: new Date() },
      update: { relationType: 'SERVES', lastSeenAt: new Date() },
    });
    links += 1;
  }
}

console.log(JSON.stringify({
  cityPowerPolygons: cityPower.length,
  eskomPolygons: eskom.length,
  electricityDepots: powerNodes.length,
  waterDepots: waterNodes.length,
  suburbsChecked: localities.length,
  suppliersSet: suppliers,
  depotLinks: links,
}, null, 2));
await prisma.$disconnect();
