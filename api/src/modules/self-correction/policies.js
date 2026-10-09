import { env } from '../../config/env.js';

// Pure eligibility rules (§4, §9, §13). No I/O: every input is a value the caller already has, so this is
// trivially unit-testable and never itself decides whether to contact the database or the provider.

/** "policyName@policyVersion" pairs explicitly allowed to auto-apply. Empty = nothing may auto-apply, whatever the mode. */
export function parseAllowlist(raw = env.SELF_CORRECTION_POLICIES) {
  return new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export const isAllowlisted = (policyName, policyVersion, allowlist = parseAllowlist()) => allowlist.has(`${policyName}@${policyVersion}`);

/**
 * The hard invariants (§4) that must hold before anything else, for every proposal and every action: service
 * isolation, municipality isolation, and human-decision precedence. A candidate that fails these is rejected
 * before scoring or verification, never merely penalised.
 */
export function checkInvariants({ postServiceType, targetServiceType = null, postMunicipalityId = null, targetMunicipalityId = null, hasHumanOverride = false, hasConflictingLesson = false }) {
  const violations = [];
  if (targetServiceType && postServiceType && postServiceType !== targetServiceType) violations.push(`cross-service: post is ${postServiceType}, target is ${targetServiceType}`);
  if (postMunicipalityId != null && targetMunicipalityId != null && postMunicipalityId !== targetMunicipalityId) violations.push('cross-municipality: post and target belong to different municipalities');
  if (hasHumanOverride) violations.push('a human LinkOverride already exists for this subject: automatic action refused');
  if (hasConflictingLesson) violations.push('active lessons in scope conflict: abstaining rather than choosing one');
  return violations;
}

/**
 * The eligibility explanation persisted on every proposal (§8, §14 --inspect). `mode` and `allowlist` are read
 * from env by default but always overridable, so tests never depend on process.env.
 */
export function eligibilityOf({ policyName, policyVersion, mode = env.SELF_CORRECTION_MODE, invariantViolations = [], allowlist = parseAllowlist() }) {
  const reasons = [...invariantViolations];
  if (mode === 'off') reasons.push('self-correction is off (SELF_CORRECTION_MODE=off)');
  else if (mode !== 'auto') reasons.push(`mode is "${mode}", not "auto": this proposal can be generated and inspected but never applied`);
  else if (!isAllowlisted(policyName, policyVersion, allowlist)) reasons.push(`policy "${policyName}@${policyVersion}" is not on SELF_CORRECTION_POLICIES`);
  const eligible = mode === 'auto' && invariantViolations.length === 0 && isAllowlisted(policyName, policyVersion, allowlist);
  return { eligible, reasons, policyName, policyVersion, mode };
}

/** Bounded work per cycle/batch (§13). Pure clamp, so callers cannot silently exceed a configured limit by one-off math. */
export function clamp(n, max) {
  return Math.max(0, Math.min(n, max));
}
