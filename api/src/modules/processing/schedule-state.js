// What the API may say about the automatic fetch schedule. server.js fills it in; anything else (tests, scripts) sees it off.
export const scheduleState = { enabled: false, intervalMs: null, nextRunAt: () => null };
