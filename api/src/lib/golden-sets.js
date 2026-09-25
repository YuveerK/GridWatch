/** Which golden files are pairwise "which posts share an outage" sets. Water review fixtures are not. */
export function isPairwiseGroupingFile(name, parsed) {
  if (!name.endsWith('.json')) return false;
  if (['corrections.json', 'states.json', 'water-reviews.json'].includes(name)) return false;
  if (Array.isArray(parsed) || parsed == null || typeof parsed !== 'object') return false;
  if (parsed._kind === 'water-review') return false;
  return true;
}

/** Structural check for a water review fixture. It is not a clustering score. */
export function checkWaterReviewCases(cases) {
  const failures = [];
  if (!Array.isArray(cases)) return { cases: 0, passed: 0, failed: 1, failures: ['not a list of review cases'] };
  for (const item of cases) {
    if (item.decision === 'IGNORED') {
      if (item.faults?.length) failures.push(`${item.externalId}: ignored case still lists faults`);
      continue;
    }
    if (!item.faults?.length) {
      failures.push(`${item.externalId}: expected faults`);
      continue;
    }
    for (const fault of item.faults) {
      if (!['NEW', 'LINKED'].includes(fault.decision)) failures.push(`${item.externalId}: fault decision ${fault.decision}`);
    }
  }
  return { cases: cases.length, passed: cases.length - failures.length, failed: failures.length, failures };
}
