// Auditable outcomes and release-gate calculations (§15). Pure functions over rows the caller already has -
// no I/O here, so gate arithmetic is exactly as testable as any other pure module in this codebase.

/** Per-status counts, for `--report` and for extending CycleQuality.summary.selfCorrection. */
export function summarizeByStatus(proposals) {
  const out = {};
  for (const p of proposals) out[p.status] = (out[p.status] ?? 0) + 1;
  return out;
}

/** Per service/source/policy family breakdown, with raw numerators and denominators (§15 requires both, never a rate alone). */
export function summarizeByFamily(proposals) {
  const out = new Map();
  for (const p of proposals) {
    const key = `${p.serviceType}|${p.sourceAccount}|${p.policyName}@${p.policyVersion}`;
    const row = out.get(key) ?? { serviceType: p.serviceType, sourceAccount: p.sourceAccount, policyName: p.policyName, policyVersion: p.policyVersion, total: 0, byStatus: {} };
    row.total += 1;
    row.byStatus[p.status] = (row.byStatus[p.status] ?? 0) + 1;
    out.set(key, row);
  }
  return [...out.values()];
}

const DEFAULT_GATE = { minSamples: 200, minDistinctIncidentClusters: 1, minDays: 14, minAccuracy: 0.995 };

/**
 * §15's proposed initial activation gate for one policy family/deployment scope. `adjudicated` must come from an
 * INDEPENDENT review process outside this engine (§15: "Proposed/automatic decisions must not generate their own
 * correctness labels") - this function only does the arithmetic honestly, it never manufactures the inputs.
 *   adjudicated: { correct, total, distinctIncidentClusters, criticalMisrepairs }
 */
export function releaseGateStatus({ policyName, policyVersion, adjudicated, windowDays, thresholds = DEFAULT_GATE }) {
  const reasons = [];
  if (!adjudicated || adjudicated.total === 0) reasons.push('no independently adjudicated proposals exist yet for this policy family');
  const total = adjudicated?.total ?? 0;
  const correct = adjudicated?.correct ?? 0;
  const distinctClusters = adjudicated?.distinctIncidentClusters ?? 0;
  const criticalMisrepairs = adjudicated?.criticalMisrepairs ?? 0;
  if (total > 0 && total < thresholds.minSamples) reasons.push(`only ${total} independently reviewed eligible proposals (need ${thresholds.minSamples})`);
  if (total > 0 && distinctClusters < thresholds.minDistinctIncidentClusters) reasons.push(`only ${distinctClusters} distinct incident cluster(s) behind those ${total} opportunities`);
  if (windowDays < thresholds.minDays) reasons.push(`only ${windowDays} day(s) of evidence (need ${thresholds.minDays})`);
  const accuracy = total ? correct / total : null;
  if (accuracy != null && accuracy < thresholds.minAccuracy) reasons.push(`accuracy ${(accuracy * 100).toFixed(1)}% is below the ${(thresholds.minAccuracy * 100).toFixed(1)}% gate`);
  if (criticalMisrepairs > 0) reasons.push(`${criticalMisrepairs} observed critical misrepair(s): the gate is refused regardless of sample size`);
  return { policyName, policyVersion, eligible: reasons.length === 0, reasons, accuracy, sampleCount: total, distinctIncidentClusters: distinctClusters, windowDays, criticalMisrepairs };
}

/** A whole report is honest only when every family is reported, including ones with zero evidence (§15: "report total opportunities and abstentions separately"). */
export function releaseGateReport(families, adjudicatedByFamily, windowDays) {
  return families.map((f) => releaseGateStatus({ policyName: f.policyName, policyVersion: f.policyVersion, adjudicated: adjudicatedByFamily.get(`${f.policyName}@${f.policyVersion}`) ?? null, windowDays }));
}
