const WATER = /\b(water supply|water pipe|pipe burst|burst pipe|reservoir|water tanker|treatment plant|rand water|wastewater|sewer)\b/i;
const POWER = /\b(substation|feeder|distributor|transformer|mini-?sub|loadshedding|\bkv\b|power (supply|outage|interruption|alert)|electricity)\b/i;
const WATER_TAG = /#water\w*/i; // "#WaterSupplyUpdate", "#WaterSupplyInterruption", "#WaterUpdate"
const isWater = (text) => (WATER.test(text) || WATER_TAG.test(text)) && !POWER.test(text);

/**
 * A post whose account serves one utility but whose content is clearly another.
 * Returns the other service, or null when the post belongs here or is ambiguous.
 * Water on an electricity account is ignored. It is not turned into a water incident.
 * `threadText` is the first post of the thread this one continues: City of Tshwane posts its water updates on the electricity
 * account as threads ("1/3 #WaterSupplyUpdate: Soshanguve Pipeline Repair..."), and "2/3 ...the second seal..." no longer
 * says water. A continuation whose own words decide nothing follows its thread; its own power words still win.
 */
export function unsupportedService({ serviceType, text = '', result = null, threadText = null }) {
  if (serviceType === 'WATER') return null;
  const reason = String(result?.review_reason ?? '');
  if (/water/i.test(reason) && /not electricity|rather than electricity|water utility|about water|processes electricity/i.test(reason)) return 'WATER';
  const body = `${text} ${result?.update_summary ?? ''}`;
  if (isWater(body)) return 'WATER';
  if (threadText && !POWER.test(body) && isWater(threadText)) return 'WATER';
  return null;
}
