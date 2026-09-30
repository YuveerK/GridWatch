export function outageQueryKey({ service, status, sort, q, centre }) {
  return JSON.stringify([service, status, sort, q ?? '', centre ?? '']);
}

export function mergeOutagePage(current, incoming, replace) {
  if (replace) return incoming ?? [];
  const seen = new Set((current ?? []).map((row) => row.id));
  return [...(current ?? []), ...(incoming ?? []).filter((row) => row?.id && !seen.has(row.id))];
}

export function pageStillCurrent(request, active) {
  return request.key === active.key && request.seq === active.seq;
}

/** Show more is only valid when no first-page reload, including refresh, is in flight. */
export function appendAllowed(lock) {
  return !lock?.reload && !lock?.paging;
}
