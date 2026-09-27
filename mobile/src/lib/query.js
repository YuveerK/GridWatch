/** Every list, map and suburb request names its service. Electricity is never left to the server default. */
export function withService(path, service) {
  if (service !== 'ELECTRICITY' && service !== 'WATER') {
    throw new Error('service must be ELECTRICITY or WATER');
  }
  const [base, query = ''] = String(path).split('?');
  const params = new URLSearchParams(query);
  params.set('service', service);
  return `${base}?${params.toString()}`;
}

/** Drop anything that belongs to the other utility before it can be shown.
 * @template T
 * @param {T[] | null | undefined} rows
 * @param {string} service
 * @returns {T[]}
 */
export function sameService(rows, service) {
  return (rows ?? []).filter((row) => (row?.service ?? 'ELECTRICITY') === service);
}
