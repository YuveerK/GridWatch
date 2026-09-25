const WATER = /\b(water supply|water pipe|pipe burst|burst pipe|reservoir|water tanker|treatment plant|rand water|wastewater|sewer)\b/i;
const POWER = /\b(substation|feeder|distributor|transformer|mini-?sub|loadshedding|\bkv\b|power (supply|outage|interruption|alert)|electricity)\b/i;

/**
 * A post whose account serves one utility but whose content is clearly another.
 * Returns the other service, or null when the post belongs here or is ambiguous.
 * Water on an electricity account is ignored. It is not turned into a water incident.
 */
export function unsupportedService({ serviceType, text = '', result = null }) {
  if (serviceType === 'WATER') return null;
  const reason = String(result?.review_reason ?? '');
  if (/water/i.test(reason) && /not electricity|rather than electricity|water utility|about water|processes electricity/i.test(reason)) return 'WATER';
  const body = `${text} ${result?.update_summary ?? ''}`;
  if (WATER.test(body) && !POWER.test(body)) return 'WATER';
  return null;
}
