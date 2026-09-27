export const RELATION = {
  SUPPLIES: 'Supplies', PUMPS_TO: 'Pumps to', DIRECTLY_SUPPLIES: 'Directly supplies',
  FEEDS: 'Feeds', PART_OF: 'Part of', UPSTREAM_OF: 'Upstream of',
  BYPASSES: 'Bypasses', BACKFEEDS: 'Backfeeds', LEGACY_PARENT: 'Reported association',
  SERVES: 'Serves', ASSOCIATED: 'Reported association', ADMINISTRATIVE: 'Service administration',
};
export function assetSymbol(type) {
  if (type === 'SDC') return 'D';
  if (['RESERVOIR', 'WATER_TOWER'].includes(type)) return type === 'RESERVOIR' ? 'R' : 'T';
  if (type === 'TREATMENT_WORKS') return 'B';
  if (['PUMP_STATION', 'BOOSTER_STATION'].includes(type)) return 'P';
  if (['SUBSTATION', 'MINI_SUBSTATION', 'SWITCHING_STATION', 'TRANSFORMER'].includes(type)) return 'S';
  if (['DISTRIBUTOR', 'FEEDER', 'CABLE', 'WATER_PIPELINE', 'DIRECT_FEED', 'BULK_CONNECTION'].includes(type)) return 'F';
  return 'A';
}
export const SYMBOLS = { D: 'Depot', B: 'Treatment works', R: 'Reservoir', T: 'Tower', P: 'Pump', S: 'Station / transformer', F: 'Feed / circuit', A: 'Other asset' };
export const hasPosition = (item) => item?.lon != null && item?.lat != null;
export const positionLabel = (item) => !hasPosition(item) ? 'Position unknown' : item.derived === true ? 'Estimated from associated suburbs' : item.derived === false ? 'Recorded asset coordinates' : 'Position source unknown';
export const safeSourceUrl = (url) => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; } };
export function networkParams(current, changes) {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) value == null || value === '' ? params.delete(key) : params.set(key, value);
  return params;
}

/** Upstream first. Electricity and water use different roles; the suburb is always the last tier. */
const POWER_BANDS = [
  { id: 'station', label: 'Substations', types: ['SUBSTATION', 'SWITCHING_STATION'] },
  { id: 'circuit', label: 'Circuits', types: ['DISTRIBUTOR', 'FEEDER', 'CABLE'] },
  { id: 'street', label: 'Street equipment', types: ['MINI_SUBSTATION', 'TRANSFORMER', 'KIOSK', 'OTHER'] },
];
const WATER_BANDS = [
  { id: 'bulk', label: 'Bulk supply', types: ['TREATMENT_WORKS', 'BULK_CONNECTION', 'BULK_METER'] },
  { id: 'storage', label: 'Storage', types: ['RESERVOIR', 'WATER_TOWER', 'WATER_SYSTEM'] },
  { id: 'pump', label: 'Pumping', types: ['PUMP_STATION', 'BOOSTER_STATION'] },
  { id: 'route', label: 'Supply routes', types: ['DIRECT_FEED', 'WATER_PIPELINE', 'PRV', 'WATER_OTHER'] },
];

export function supplyBands(service) {
  return service === 'WATER' ? WATER_BANDS : POWER_BANDS;
}

export function bandFor(type, service) {
  return supplyBands(service).find((band) => band.types.includes(type)) ?? null;
}

/** Group assets into supply bands, highest in the network first. Unknown roles stay last. */
export function groupByBand(items, service, typeOf = (item) => item.type) {
  const groups = new Map(supplyBands(service).map((band) => [band.id, { ...band, items: [] }]));
  const other = { id: 'other', label: 'Other assets', items: [] };
  for (const item of items) {
    const band = bandFor(typeOf(item), service);
    (band ? groups.get(band.id) : other).items.push(item);
  }
  return [...groups.values(), other].filter((group) => group.items.length);
}

/** Service centres and membership are not steps in the supply path. A recorded parent link is. */
export function isAdministrativeEdge(edge) {
  return edge?.asset?.type === 'SDC' || edge?.relationType === 'PART_OF';
}

export function linkLabel(relationType) {
  if (relationType === 'PART_OF') return 'Not a supply route';
  if (relationType === 'LEGACY_PARENT') return 'Recorded link';
  return RELATION[relationType] ?? 'Reported association';
}

export function diagramCopy(service, focusType) {
  const depot = focusType === 'SDC';
  const water = service === 'WATER';
  return {
    lede: depot
      ? 'A service centre coordinates repairs. Read downward through the equipment it looks after, then the suburbs named with it. This is not the path power takes.'
      : water
        ? 'Read downward: bulk supply and storage, then this asset, then the suburbs it reaches. A link is recorded from notices. It is not a traced pipe.'
        : 'Read downward: substation, circuit, street equipment, then the suburbs. A link is recorded from notices. It is not a traced cable.',
    above: 'Feeds this asset',
    below: depot ? 'Equipment it looks after' : 'Supplied onward',
    suburbs: 'Suburbs reached',
    aboveEmpty: 'Nothing recorded above this asset.',
    belowEmpty: 'No further assets recorded below this one.',
  };
}
