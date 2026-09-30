/** Versioned last-known results for one suburb. A failed request never becomes a successful empty list. */

export function unknownService() {
  return { state: 'unknown', rows: [], savedAt: null, sourceAt: null, stale: false };
}

function okService(rows, sourceAt, savedAt = Date.now()) {
  return { state: 'ok', rows: rows ?? [], savedAt, sourceAt: sourceAt ?? null, stale: false };
}

function legacyService(rows, sourceAt) {
  if (!Array.isArray(rows) || rows.length === 0) return unknownService();
  return { ...okService(rows, sourceAt, null), stale: true };
}

export function emptyAreaCache() {
  return { version: 2, power: unknownService(), water: unknownService() };
}

/** Old caches stored failed services as []. Those empties are unknown, not "no reports". */
export function migrateAreaCache(data) {
  if (!data || typeof data !== 'object') return emptyAreaCache();
  if (data.version === 2 && data.power && data.water) {
    return {
      version: 2,
      power: data.power.state === 'ok' ? { ...unknownService(), ...data.power, state: 'ok' } : unknownService(),
      water: data.water.state === 'ok' ? { ...unknownService(), ...data.water, state: 'ok' } : unknownService(),
    };
  }
  return {
    version: 2,
    power: legacyService(data.power, data.updatedAt),
    water: legacyService(data.water, data.updatedAt),
  };
}

function nextService(previous, result, sourceAt) {
  if (result?.ok) return okService(result.rows, sourceAt);
  if (previous?.state === 'ok') return { ...previous, stale: true };
  return unknownService();
}

/** Update one service without touching the other. A failure keeps the last success. */
export function applyAreaResult(cache, service, result, sourceAt) {
  const base = cache?.version === 2 ? cache : migrateAreaCache(cache);
  if (service !== 'power' && service !== 'water') return base;
  return {
    ...base,
    version: 2,
    [service]: nextService(base[service], result, sourceAt ?? base[service]?.sourceAt),
  };
}

/** Keep the last successful rows for a service that failed this time. */
export function nextAreaCache(previous, results) {
  const base = previous?.version === 2 ? previous : migrateAreaCache(previous);
  return {
    version: 2,
    power: nextService(base.power, results.power, results.sourceAt),
    water: nextService(base.water, results.water, results.sourceAt),
  };
}
