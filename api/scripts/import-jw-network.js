// Import the curated Johannesburg Water network. Does not create localities.
//   node scripts/import-jw-network.js --dry-run
//   node scripts/import-jw-network.js --allow-ambiguous
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { baseNormalize, infraKey, localityKey } from '../src/lib/normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowAmbiguous = args.includes('--allow-ambiguous');
const network = JSON.parse(readFileSync(join(root, 'data/johannesburg-water/network.json'), 'utf8'));
const aliases = JSON.parse(readFileSync(join(root, 'data/johannesburg-water/aliases.json'), 'utf8'));

const municipality = await prisma.municipality.findFirst({ where: { code: 'JOHANNESBURG' } });
if (!municipality) {
  console.error('Johannesburg municipality is not seeded');
  process.exit(1);
}

const report = { matched: [], alias: [], ambiguous: [], missing: [], noBoundary: [] };
const counts = { assetsCreated: 0, assetsUpdated: 0, relationshipsCreated: 0, relationshipsUpdated: 0, localities: 0 };

const WATER_WORDS = /\b(reservoirs?|towers?|direct feeds?|pump stations?|boosters?|prv|systems?)\b/g;
const waterKey = (name) => baseNormalize(name).replace(WATER_WORDS, ' ').replace(/\s+/g, ' ').trim();
const parentKey = (key) => key.replace(/ ext( \d+)*( and \d+)*$/, '').trim();

function scope(list) {
  return (list ?? []).filter((r) => r.municipalityId == null || r.municipalityId === municipality.id);
}

const locs = await prisma.locality.findMany({
  where: { active: true },
  select: { id: true, canonicalName: true, normalizedName: true, boundary: true, municipalityId: true },
});
const aliasRows = await prisma.localityAlias.findMany({
  where: { status: { not: 'REJECTED' } },
  select: { localityId: true, normalizedAlias: true },
});
const byId = new Map(locs.map((l) => [l.id, l]));
const byKey = new Map();
const addKey = (key, loc) => {
  if (!key || !loc) return;
  const list = byKey.get(key) ?? [];
  if (!list.some((x) => x.id === loc.id)) list.push(loc);
  byKey.set(key, list);
};
for (const loc of locs) addKey(loc.normalizedName, loc);
for (const row of aliasRows) addKey(row.normalizedAlias, byId.get(row.localityId));

function matchLocality(name) {
  const aliased = aliases[name.toLowerCase()] ?? name;
  const key = localityKey(aliased);
  const exact = scope(byKey.get(key));
  if (exact.length === 1) return { status: aliased !== name || key !== localityKey(name) ? 'alias' : 'matched', locality: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', name };
  const parent = parentKey(key);
  const folded = parent && parent !== key ? scope(byKey.get(parent)) : [];
  if (folded.length === 1) return { status: 'alias', locality: folded[0] };
  if (folded.length > 1) return { status: 'ambiguous', name };
  return { status: 'missing', name };
}

function metadataFor(asset) {
  const metadata = {
    operator: asset.operator ?? null,
    stands: asset.stands ?? null,
    capacityKl: asset.capacityKl ?? null,
    aaddKlDay: asset.aaddKlDay ?? null,
    storageHours: asset.storageHours ?? null,
    storageNote: asset.storageNote ?? null,
    rwConnections: asset.rwConnections ?? null,
    connectionLabel: asset.connectionLabel ?? null,
    source: 'johannesburg-water-official',
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, v]) => v != null));
}

const existingNodes = await prisma.infraNode.findMany({
  where: { serviceType: 'WATER', municipalityId: municipality.id },
});

function findExisting(asset, normalizedKey) {
  const sameType = existingNodes.filter((n) => n.type === asset.type);
  const exact = sameType.filter((n) => n.normalizedKey === normalizedKey);
  if (exact.length === 1) return exact[0];
  const wk = waterKey(asset.name);
  const folded = sameType.filter((n) => waterKey(n.name) === wk || n.normalizedKey === wk);
  return folded.length === 1 ? folded[0] : null;
}

async function evidenceOnce(data) {
  const rows = await prisma.infrastructureEvidence.findMany({
    where: { sourceId: data.sourceId, nodeId: data.nodeId ?? null, parentId: data.parentId ?? null, childId: data.childId ?? null, evidenceKind: data.evidenceKind },
    select: { id: true, metadata: true, relationType: true },
  });
  const dup = rows.find((r) => r.relationType === (data.relationType ?? null) && JSON.stringify(r.metadata ?? null) === JSON.stringify(data.metadata ?? null));
  if (!dup) await prisma.infrastructureEvidence.create({ data });
}

const nodeByKey = new Map();
const suburbCount = new Map();
for (const row of network.assetLocalities) suburbCount.set(row.assetKey, (suburbCount.get(row.assetKey) ?? 0) + 1);

for (const asset of network.assets) {
  const normalizedKey = infraKey(asset.name);
  const data = {
    type: asset.type,
    name: asset.name,
    normalizedKey,
    serviceType: 'WATER',
    municipalityId: municipality.id,
    lifecycle: 'CONFIRMED',
    metadata: metadataFor(asset),
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };
  if (dryRun) {
    nodeByKey.set(asset.key, { id: `dry-${asset.key}`, ...data });
    counts.assetsCreated += 1;
    continue;
  }
  const existing = findExisting(asset, normalizedKey);
  const node = existing
    ? await prisma.infraNode.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        metadata: { ...(existing.metadata ?? {}), ...data.metadata },
        lifecycle: 'CONFIRMED',
        lastSeenAt: new Date(),
      },
    })
    : await prisma.infraNode.create({ data });
  if (existing) counts.assetsUpdated += 1;
  else {
    counts.assetsCreated += 1;
    existingNodes.push(node);
  }
  nodeByKey.set(asset.key, node);
  for (const url of asset.sourceUrls ?? []) {
    const sourceType = url.endsWith('.pdf') ? 'OFFICIAL_DOCUMENT' : 'OFFICIAL_WEB';
    const source = await prisma.knowledgeSource.upsert({
      where: { sourceType_url: { sourceType, url } },
      create: { id: randomUUID(), sourceType, title: asset.name, url },
      update: {},
    });
    await evidenceOnce({ sourceId: source.id, nodeId: node.id, evidenceKind: 'ASSET', metadata: { key: asset.key } });
  }
}

for (const rel of network.relationships) {
  const parent = nodeByKey.get(rel.from);
  const child = nodeByKey.get(rel.to);
  if (!parent || !child || dryRun) {
    if (dryRun && parent && child) counts.relationshipsCreated += 1;
    continue;
  }
  const where = { parentId_childId_relationType: { parentId: parent.id, childId: child.id, relationType: rel.type } };
  const existing = await prisma.infraEdge.findUnique({ where });
  if (existing) {
    await prisma.infraEdge.update({ where, data: { lastSeenAt: new Date() } });
    counts.relationshipsUpdated += 1;
  } else {
    await prisma.infraEdge.create({ data: { parentId: parent.id, childId: child.id, relationType: rel.type, lastSeenAt: new Date() } });
    counts.relationshipsCreated += 1;
  }
  const source = await prisma.knowledgeSource.upsert({
    where: { sourceType_url: { sourceType: rel.sourceUrl.endsWith('.pdf') ? 'OFFICIAL_DOCUMENT' : 'OFFICIAL_WEB', url: rel.sourceUrl } },
    create: { id: randomUUID(), sourceType: rel.sourceUrl.endsWith('.pdf') ? 'OFFICIAL_DOCUMENT' : 'OFFICIAL_WEB', url: rel.sourceUrl },
    update: {},
  });
  await evidenceOnce({ sourceId: source.id, parentId: parent.id, childId: child.id, relationType: rel.type, evidenceKind: 'RELATIONSHIP' });
}

const served = new Map();
for (const row of network.assetLocalities) {
  const node = nodeByKey.get(row.assetKey);
  const hit = matchLocality(row.localityName);
  report[hit.status === 'matched' ? 'matched' : hit.status === 'alias' ? 'alias' : hit.status].push(row.localityName);
  if (!hit.locality || !node || dryRun) continue;
  counts.localities += 1;
  await prisma.nodeLocality.upsert({
    where: { nodeId_localityId: { nodeId: node.id, localityId: hit.locality.id } },
    create: { nodeId: node.id, localityId: hit.locality.id, relationType: 'SERVES', lastSeenAt: new Date() },
    update: { relationType: 'SERVES', lastSeenAt: new Date() },
  });
  const list = served.get(node.id) ?? [];
  list.push(hit.locality);
  served.set(node.id, list);
  if (!hit.locality.boundary) report.noBoundary.push(row.localityName);
}

if (!dryRun) {
  for (const [nodeId, locs] of served) {
    const assetKey = [...nodeByKey.entries()].find(([, n]) => n.id === nodeId)?.[0];
    const withBoundary = locs.filter((l) => l.boundary);
    if (suburbCount.get(assetKey) === 1 && withBoundary.length === 1) {
      await prisma.infraNode.update({ where: { id: nodeId }, data: { boundary: withBoundary[0].boundary, geoSource: 'derived-from-localities' } });
    }
  }
}

const outPath = join(root, 'data/johannesburg-water/match-report.json');
writeFileSync(outPath, JSON.stringify({ dryRun, counts, report }, null, 2));
console.log(JSON.stringify(counts, null, 2));
console.log(`Locality mappings: matched ${report.matched.length}, aliases ${report.alias.length}, ambiguous ${report.ambiguous.length}, missing ${report.missing.length}`);
if (report.ambiguous.length && !allowAmbiguous) process.exit(1);
await prisma.$disconnect();
