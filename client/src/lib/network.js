export const RELATION = {
  SUPPLIES: 'Supplies', PUMPS_TO: 'Pumps to', DIRECTLY_SUPPLIES: 'Directly supplies',
  FEEDS: 'Feeds', PART_OF: 'Part of', UPSTREAM_OF: 'Upstream of',
  BYPASSES: 'Bypasses', BACKFEEDS: 'Backfeeds', LEGACY_PARENT: 'Reported association',
  SERVES: 'Serves', ASSOCIATED: 'Reported association', ADMINISTRATIVE: 'Service administration',
};
export function assetSymbol(type) {
  if (type === 'SDC') return 'D';
  if (['RESERVOIR', 'WATER_TOWER'].includes(type)) return type === 'RESERVOIR' ? 'R' : 'T';
  if (['PUMP_STATION', 'BOOSTER_STATION'].includes(type)) return 'P';
  if (['SUBSTATION', 'MINI_SUBSTATION', 'SWITCHING_STATION', 'TRANSFORMER'].includes(type)) return 'S';
  if (['DISTRIBUTOR', 'FEEDER', 'CABLE', 'WATER_PIPELINE', 'DIRECT_FEED', 'BULK_CONNECTION'].includes(type)) return 'F';
  return 'A';
}
export const SYMBOLS = { D: 'Depot', R: 'Reservoir', T: 'Tower', P: 'Pump', S: 'Station / transformer', F: 'Feed / circuit', A: 'Other asset' };
export const hasPosition = (item) => item?.lon != null && item?.lat != null;
export const positionLabel = (item) => !hasPosition(item) ? 'Position unknown' : item.derived === true ? 'Estimated from associated suburbs' : item.derived === false ? 'Recorded asset coordinates' : 'Position source unknown';
export const safeSourceUrl = (url) => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; } };
export function networkParams(current, changes) {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) value == null || value === '' ? params.delete(key) : params.set(key, value);
  return params;
}
