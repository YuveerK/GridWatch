import { areaHeadline } from './area.js';

export function loadingUnit() {
  return { state: 'loading', label: 'Checking…', tone: 'idle', icon: 'clock', savedAt: null };
}

export function unitFromRows(rows, service, savedAt = Date.now()) {
  const meta = areaHeadline(rows, service);
  return { state: 'ok', label: meta.label, tone: meta.tone, icon: meta.icon, savedAt };
}

function remembered(unit) {
  return unit && (unit.state === 'ok' || unit.state === 'stale') && unit.label && unit.label !== 'Checking…' && unit.label !== 'Unavailable';
}

/** A failed read keeps the last successful label. It does not become a new empty success. */
export function mergeUnit(previous, settled, service, now = Date.now()) {
  if (settled?.status === 'fulfilled') return unitFromRows(settled.value?.data ?? [], service, now);
  if (remembered(previous)) return { ...previous, state: 'stale' };
  return { state: 'error', label: 'Unavailable', tone: 'idle', icon: 'alert', savedAt: previous?.savedAt ?? null };
}

/** Write the incoming row, but never replace a saved success with an error. */
export function keepFollowingCache(previous, incoming) {
  const prior = new Map((previous ?? []).map((row) => [row.id, row]));
  return (incoming ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    power: row.power?.state === 'error' && remembered(prior.get(row.id)?.power) ? { ...prior.get(row.id).power, state: 'stale' } : row.power,
    water: row.water?.state === 'error' && remembered(prior.get(row.id)?.water) ? { ...prior.get(row.id).water, state: 'stale' } : row.water,
  }));
}
