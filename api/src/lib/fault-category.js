// City Power states a cause in free text ("cable fault", "faulty cable", "multiple cable faults"). To see what is really
// behind the outages those wordings are sorted into a small fixed set. The rules are plain patterns (no AI, no cost) and the
// first match wins, so the order matters: theft is a cable problem too, but "cable theft" is its own story.

export const CATEGORIES = [
  { id: 'THEFT_VANDALISM', label: 'Theft or vandalism', pattern: /theft|stolen|steal|vandal|tamper|sabotage/i },
  { id: 'EXTERNAL', label: 'Accident, weather or third party', pattern: /accident|crash|vehicle|truck|\bcar\b|excavat|digging|construction|contractor|drill|tree|storm|lightning|flood|rain|wind|fire|explosion|burst|water|pipe/i },
  { id: 'MAINTENANCE', label: 'Isolation or maintenance', pattern: /maintenance|isolat|planned|refurbish|upgrade|replacement|essential work/i },
  { id: 'CABLE', label: 'Cable fault', pattern: /cable|underground|joint|conductor|overhead line|\bline\b/i },
  { id: 'EQUIPMENT', label: 'Transformer or substation equipment', pattern: /transformer|substation|switchgear|breaker|busbar|isolator|mini.?sub|ring main|relay|feeder board|distributor|protection|panel|meter box|kiosk|capacitor|pole|equipment/i },
  { id: 'OVERLOAD', label: 'Overload or tripping', pattern: /overload|tripp|trip\b|demand|load|constrain|fuse/i },
];
export const WATER_CATEGORIES = [
  { id: 'BURST', label: 'Burst or leaking pipe', pattern: /burst|leak|pipe/i },
  { id: 'NO_PUMPING', label: 'Pumping or power to pumps', pattern: /pump|no pumping|power (outage|restored|failure)|electricity/i },
  { id: 'INCOMING', label: 'Incoming or bulk supply', pattern: /incoming|rand water|bulk|upstream/i },
  { id: 'BYPASS', label: 'Bypass or backfeed', pattern: /bypass|backfeed/i },
  { id: 'DEMAND', label: 'Demand or restriction', pattern: /demand|throttl|restrict|constrain/i },
  { id: 'CLOSURE', label: 'Overnight or planned closure', pattern: /overnight|closure|closed/i },
  { id: 'REPAIRS', label: 'Repairs or valve work', pattern: /repair|valve|\bprv\b|maintenance/i },
];
export const OTHER = { id: 'OTHER', label: 'Other stated cause' };
export const UNKNOWN = { id: 'UNKNOWN', label: 'Cause not stated' };
export const ALL_CATEGORIES = [...CATEGORIES, OTHER, UNKNOWN];
export const ALL_WATER_CATEGORIES = [...WATER_CATEGORIES, OTHER, UNKNOWN];
export const categoryLabel = (id) => [...ALL_CATEGORIES, ...WATER_CATEGORIES].find((c) => c.id === id)?.label ?? id;

/** The category id for a stated cause ('UNKNOWN' when City Power gave none). */
export function categorize(cause) {
  const text = String(cause ?? '').trim();
  if (!text) return 'UNKNOWN';
  return CATEGORIES.find((c) => c.pattern.test(text))?.id ?? 'OTHER';
}

/** The category id for a stated water cause. Electricity rules must not label a burst pipe as an accident. */
export function categorizeWater(cause) {
  const text = String(cause ?? '').trim();
  if (!text) return 'UNKNOWN';
  return WATER_CATEGORIES.find((c) => c.pattern.test(text))?.id ?? 'OTHER';
}
