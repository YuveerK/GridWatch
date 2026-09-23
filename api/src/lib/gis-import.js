// Shared logic for merging an official municipal GIS area dataset (see docs/Johannesburg/ and
// docs/Tshwane/'s build_*_area_dataset.py builders) into GridWatch's suburb geography, without duplicating
// the matching rules (and their sharp edges) per municipality.
//
// For every official area in the dataset:
//   - a real suburb/estate (a "base" type) is matched to an existing Locality (by name or an already-known
//     alias) or created; either way it gets a government-sourced centre point, its official electricity
//     supply match if any, and its name variants as aliases.
//   - a cadastral extension/zone/agricultural holding is matched to an existing Locality the same way; if
//     none exists, its variants are folded in as aliases of its *parent* suburb instead of becoming a new
//     row (posts refer to "X Ext 2", not a separate suburb) so matching doesn't fragment or bloat search.
//   - anything with neither an existing match nor a discoverable parent is left out of the database
//     entirely (still visible in the source JSON) rather than creating unreachable inactive rows that
//     `/v1/search` and `/v1/localities` would otherwise surface (those endpoints don't filter by `active`).
//
// Region codes are only unique *within* a municipality (Johannesburg's "A" and Tshwane's "1" are unrelated),
// so every lookup here is scoped to the one municipality being imported - never built from the whole
// Region/Locality table, or two municipalities' data could collide or cross-contaminate matches.
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { baseNormalize } from './normalize.js';

/**
 * @param {object} opts
 * @param {object[]} opts.records - parsed area_index.json records
 * @param {string} opts.municipalityId
 * @param {Set<string>} opts.baseTypes - record `area_type` values that are real suburbs/estates, not extensions
 * @param {string} opts.source - short label stored as LocalityAlias.source / Locality.geoSource (e.g. 'coj-cgis')
 * @param {string} [opts.primarySupplierName] - the municipality's own utility name (e.g. 'City Power'), if the
 *   dataset carries an `electricity_supply_match` field worth flagging deviations from; omit if none is trustworthy
 * @param {boolean} [opts.dryRun]
 */
export async function importGisAreas({ records, municipalityId, baseTypes, source, primarySupplierName, dryRun = false }) {
  const regions = await prisma.region.findMany({ where: { municipalityId } });
  const regionByCode = new Map(regions.map((r) => [r.code, r]));
  // A municipality's first import creates its Region rows too (named "Region <code>", matching how both
  // Johannesburg's A-G and Tshwane's 1-7 are already named) - region membership is always derived from the
  // dataset's own spatial assignment, never maintained by hand.
  for (const code of new Set(records.map((r) => r.region).filter(Boolean))) {
    if (regionByCode.has(code)) continue;
    if (dryRun) {
      regionByCode.set(code, { id: `dry-region-${code}`, code, municipalityId });
      continue;
    }
    regionByCode.set(code, await prisma.region.create({ data: { id: randomUUID(), code, name: `Region ${code}`, municipalityId } }));
  }
  const regionIds = [...regionByCode.values()].map((r) => r.id);

  // Localities already in this municipality's regions, plus region-less ones (posts learned these before any
  // region was known - today that only happens for the municipality already being imported).
  const existingLocalities = await prisma.locality.findMany({ where: { OR: [{ regionId: { in: regionIds } }, { regionId: null }] } });
  const localityById = new Map(existingLocalities.map((l) => [l.id, l]));
  const byRegionAndName = new Map(existingLocalities.map((l) => [`${l.regionId ?? ''}|${l.normalizedName}`, l]));
  const byNameAnywhere = new Map();
  for (const l of existingLocalities) byNameAnywhere.set(l.normalizedName, [...(byNameAnywhere.get(l.normalizedName) ?? []), l]);

  const aliasRows = await prisma.localityAlias.findMany({ where: { status: { not: 'REJECTED' }, localityId: { in: existingLocalities.map((l) => l.id) } } });
  const byAlias = new Map();
  for (const a of aliasRows) if (!byAlias.has(a.normalizedAlias)) byAlias.set(a.normalizedAlias, a.localityId);

  const stats = {
    baseMatched: 0,
    baseCreated: 0,
    extMatchedExisting: 0,
    extFoldedIntoParent: 0,
    extSkipped: 0,
    coordsBackfilled: 0,
    suppliersSet: 0,
    boundariesSet: 0,
    aliasesAdded: 0,
    nonPrimarySupplier: new Map(), // canonicalName -> supply match, for suburbs not matching the municipality's own utility
    ambiguous: [],
  };

  /** A locality that genuinely IS `name` (its own canonical name), not one that merely answers to it via an alias.
   * A same-named suburb in more than one region is normal (see geography-seed.js `collisions`); this only
   * matches an existing row in the record's own region, or a name that is unambiguous within this municipality. */
  function findOwnRow(name, regionCode) {
    const key = baseNormalize(name);
    if (!key) return null;
    const region = regionCode ? regionByCode.get(regionCode) : null;
    if (region) {
      const hit = byRegionAndName.get(`${region.id}|${key}`);
      if (hit) return hit;
    }
    const any = byNameAnywhere.get(key);
    if (any?.length === 1) return any[0];
    if (any?.length > 1) stats.ambiguous.push(name);
    return null;
  }

  /** Same, but also follows an alias to whatever locality it belongs to (e.g. an extension folded into its parent). */
  function findExisting(name, regionCode) {
    const own = findOwnRow(name, regionCode);
    if (own) return own;
    const aliasHit = byAlias.get(baseNormalize(name));
    return aliasHit ? localityById.get(aliasHit) : null;
  }

  function remember(loc) {
    localityById.set(loc.id, loc);
    byRegionAndName.set(`${loc.regionId ?? ''}|${loc.normalizedName}`, loc);
    byNameAnywhere.set(loc.normalizedName, [...(byNameAnywhere.get(loc.normalizedName) ?? []), loc]);
  }

  async function addAliases(locality, names) {
    for (const raw of names) {
      const normalizedAlias = baseNormalize(raw);
      if (!normalizedAlias || normalizedAlias === locality.normalizedName || byAlias.has(normalizedAlias)) continue;
      byAlias.set(normalizedAlias, locality.id);
      stats.aliasesAdded += 1;
      if (dryRun) continue;
      await prisma.localityAlias.upsert({
        where: { localityId_normalizedAlias: { localityId: locality.id, normalizedAlias } },
        update: {},
        create: { id: randomUUID(), localityId: locality.id, alias: raw, normalizedAlias, source, confidence: 0.95, status: 'CONFIRMED' },
      });
    }
  }

  async function enrich(locality, record) {
    const data = {};
    if (locality.lat == null && record.lat != null) {
      data.lat = record.lat;
      data.lon = record.lon;
      data.geoSource = source;
      stats.coordsBackfilled += 1;
    }
    if (record.electricity_supply_match && record.electricity_supply_match !== locality.electricitySupplier) {
      data.electricitySupplier = record.electricity_supply_match;
      stats.suppliersSet += 1;
    }
    if (record.boundary) {
      data.boundary = record.boundary;
      stats.boundariesSet += 1;
    }
    if (Object.keys(data).length) {
      Object.assign(locality, data);
      if (!dryRun) await prisma.locality.update({ where: { id: locality.id }, data });
    }
    if (primarySupplierName && record.electricity_supply_match && record.electricity_supply_match !== primarySupplierName) {
      stats.nonPrimarySupplier.set(locality.canonicalName, record.electricity_supply_match);
    }
    await addAliases(locality, [record.area_name, ...(record.aliases ?? [])]);
  }

  const baseRecords = records.filter((r) => baseTypes.has(r.area_type));
  const otherRecords = records.filter((r) => !baseTypes.has(r.area_type));

  for (const r of baseRecords) {
    const existing = findExisting(r.area_name, r.region);
    if (existing) {
      stats.baseMatched += 1;
      await enrich(existing, r);
      continue;
    }
    stats.baseCreated += 1;
    const region = regionByCode.get(r.region);
    const normalizedName = baseNormalize(r.area_name);
    if (dryRun) {
      remember({ id: `dry:${r.region}:${normalizedName}`, canonicalName: r.area_name, normalizedName, regionId: region?.id ?? null, lat: r.lat, lon: r.lon, electricitySupplier: r.electricity_supply_match ?? null });
      continue;
    }
    const created = await prisma.locality.create({
      data: {
        id: randomUUID(),
        canonicalName: r.area_name,
        normalizedName,
        regionId: region?.id ?? null,
        sourceLabel: `${source} import`,
        lat: r.lat,
        lon: r.lon,
        geoSource: source,
        electricitySupplier: r.electricity_supply_match ?? null,
        boundary: r.boundary ?? null,
        active: true,
        updatedAt: new Date(),
      },
    });
    remember(created);
    await addAliases(created, r.aliases ?? []);
  }

  for (const r of otherRecords) {
    // Own-row only (no alias fallback): an alias hit here means a previous run already folded this exact
    // extension into a parent, and re-enriching "the parent" with this extension's own narrow shape would
    // overwrite the parent's correctly unioned boundary/coordinates with a single extension's sliver.
    const existing = findOwnRow(r.area_name, r.region);
    if (existing) {
      stats.extMatchedExisting += 1;
      await enrich(existing, r);
      continue;
    }
    const parent = r.parent_area ? findExisting(r.parent_area, r.region) : null;
    if (parent) {
      stats.extFoldedIntoParent += 1;
      await addAliases(parent, [r.area_name, ...(r.aliases ?? [])]);
      continue;
    }
    stats.extSkipped += 1;
  }

  return stats;
}
