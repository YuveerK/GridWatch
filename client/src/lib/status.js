// ───────────── status vocabulary (one place, used everywhere) ─────────────
// Pure (no React), so the tests can import it directly.

export const STATUS = {
  ACTIVE: { label: 'Outage', long: 'Power is out', tone: 'live', icon: 'alert', order: 0 },
  PARTIALLY_RESTORED: { label: 'Partly restored', long: 'Some areas are back on', tone: 'partial', icon: 'half', order: 1 },
  PLANNED: { label: 'Planned', long: 'Planned maintenance', tone: 'plan', icon: 'calendar', order: 2 },
  RESTORED: { label: 'Restored', long: 'Power is back on', tone: 'good', icon: 'check', order: 3 },
  STALE: { label: 'No recent update', long: 'No news lately', tone: 'idle', icon: 'clock', order: 4 },
  CLOSED: { label: 'Closed', long: 'Finished', tone: 'idle', icon: 'archive', order: 5 },
  CANCELLED: { label: 'Cancelled', long: 'Planned work cancelled', tone: 'idle', icon: 'x', order: 6 },
};

const WATER_STATUS = {
  ACTIVE: { label: 'Supply interrupted', long: 'Water supply is interrupted' },
  PARTIALLY_RESTORED: { label: 'Supply returning', long: 'Supply is returning in some areas' },
  PLANNED: { long: 'Planned water interruption' },
  RESTORED: { label: 'Supply restored', long: 'Water supply is restored' },
};

/**
 * What a live Water incident's operating state means for customers. Only 'live' states are red; everything that is
 * reduced, bypassed or recovering is amber, because recovery is not the same as supply restored (and never green).
 */
export const WATER_STATE = {
  NO_SUPPLY: { label: 'No water supply', long: 'Customers have no water supply', tone: 'live', icon: 'alert' },
  EMPTY: { label: 'Reservoir empty', long: 'The reservoir is empty, so supply is off', tone: 'live', icon: 'alert' },
  NO_INCOMING_SUPPLY: { label: 'No incoming supply', long: 'No water is arriving from upstream', tone: 'live', icon: 'alert' },
  NO_PUMPING: { label: 'Pumping stopped', long: 'Pumping has stopped', tone: 'live', icon: 'alert' },
  OUTLET_CLOSED: { label: 'Outlet closed', long: 'The outlet is closed, so supply is off', tone: 'live', icon: 'alert' },
  CRITICAL: { label: 'Critically low', long: 'Levels are critically low', tone: 'live', icon: 'alert' },
  LOW: { label: 'Low levels', long: 'Levels are low; some customers may have little or no water', tone: 'partial', icon: 'half' },
  LOW_PRESSURE: { label: 'Low pressure', long: 'Water is on, but pressure is low', tone: 'partial', icon: 'half' },
  CONSTRAINED: { label: 'Supply constrained', long: 'Supply is limited', tone: 'partial', icon: 'half' },
  THROTTLED: { label: 'Supply throttled', long: 'Supply is being deliberately reduced', tone: 'partial', icon: 'half' },
  PUMPING_REDUCED: { label: 'Reduced pumping', long: 'Pumping is running below capacity', tone: 'partial', icon: 'half' },
  PARTIAL_SUPPLY: { label: 'Partial supply', long: 'Some customers have water, others do not', tone: 'partial', icon: 'half' },
  BYPASS: { label: 'On bypass', long: 'Supply is running on a temporary bypass', tone: 'partial', icon: 'half' },
  RECOVERING: { label: 'Recovering', long: 'The system is recovering; supply is not confirmed restored', tone: 'partial', icon: 'half' },
  STABLE: { label: 'Stable, monitoring', long: 'The system is stable and being monitored; restoration is not confirmed', tone: 'partial', icon: 'half' },
  NORMAL: { label: 'Normal, unconfirmed', long: 'Reported normal, but restoration has not been announced', tone: 'partial', icon: 'half' },
};

// A water state refines the badge only while the incident is live. A quiet (STALE), finished or planned incident
// keeps its lifecycle label, so "no recent update" never turns into a condition we have not heard about lately.
const REFINED = new Set(['ACTIVE', 'PARTIALLY_RESTORED']);

/** The label, tone and icon for an incident. Pass the Water operating state when there is one. */
export function statusMeta(status, service = 'ELECTRICITY', waterState = null) {
  const base = STATUS[status] ?? { label: status, long: status, tone: 'idle', icon: 'clock', order: 9 };
  if (service !== 'WATER') return base;
  const water = { ...base, ...WATER_STATUS[status] };
  const state = REFINED.has(status) ? WATER_STATE[waterState] : null;
  return state ? { ...water, ...state, order: base.order } : water;
}

/** A readable name for a Water operating state ("Low pressure"), or null. */
export const waterStateLabel = (state) => WATER_STATE[state]?.label ?? (state ? state.charAt(0) + state.slice(1).toLowerCase().replaceAll('_', ' ') : null);

/** The tone a map point takes for an incident: restored places are green, otherwise the incident's own tone. */
export const placeTone = (o, restored) => (restored ? 'good' : statusMeta(o.status, o.service, o.waterState).tone);

export const isLive = (s) => s === 'ACTIVE' || s === 'PARTIALLY_RESTORED';

export const ROLE = {
  OPENED: { label: 'First report', tone: 'live' },
  UPDATE: { label: 'Update', tone: 'plan' },
  RESTORATION: { label: 'Power restored', tone: 'good' },
};

/** The timeline label for a post's role, in the incident's own service. */
export const roleLabel = (role, service) => (role === 'RESTORATION' && service === 'WATER' ? 'Water supply restored' : (ROLE[role] ?? ROLE.UPDATE).label);

/** Where an incident is in its life: 0 reported, 1 being restored / recovering, 2 restored. */
export function progressStep(status, service = 'ELECTRICITY', waterState = null) {
  if (status === 'RESTORED' || status === 'CLOSED') return 2;
  if (status === 'PARTIALLY_RESTORED') return 1;
  if (service === 'WATER' && status === 'ACTIVE' && statusMeta(status, service, waterState).tone !== 'live') return 1;
  return 0;
}

/** The URL value for a service, and back. Lower-case words so shared links read naturally (?service=water). */
export const serviceParam = (service) => (service === 'WATER' ? 'water' : 'power');
export function serviceFromParam(value) {
  const v = (value ?? '').toLowerCase();
  if (v === 'water') return 'WATER';
  if (v === 'power' || v === 'electricity') return 'ELECTRICITY';
  return null;
}
