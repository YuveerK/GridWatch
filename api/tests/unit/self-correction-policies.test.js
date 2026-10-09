import { describe, expect, it } from 'vitest';
import { checkInvariants, clamp, eligibilityOf, isAllowlisted, parseAllowlist } from '../../src/modules/self-correction/policies.js';

describe('parseAllowlist / isAllowlisted', () => {
  it('parses comma-separated policy@version pairs', () => {
    const list = parseAllowlist('disposition-layout-repair@1, quote-restoration@1');
    expect(isAllowlisted('disposition-layout-repair', '1', list)).toBe(true);
    expect(isAllowlisted('quote-restoration', '1', list)).toBe(true);
    expect(isAllowlisted('quote-restoration', '2', list)).toBe(false);
  });

  it('an empty allowlist allows nothing', () => {
    expect(isAllowlisted('disposition-layout-repair', '1', parseAllowlist(''))).toBe(false);
    expect(isAllowlisted('disposition-layout-repair', '1', parseAllowlist(undefined))).toBe(false);
  });
});

describe('checkInvariants (§4 hard invariants)', () => {
  it('rejects a cross-service target before any scoring', () => {
    const v = checkInvariants({ postServiceType: 'WATER', targetServiceType: 'ELECTRICITY' });
    expect(v).toContain('cross-service: post is WATER, target is ELECTRICITY');
  });

  it('rejects a cross-municipality target', () => {
    const v = checkInvariants({ postServiceType: 'ELECTRICITY', postMunicipalityId: 'joburg', targetMunicipalityId: 'tshwane' });
    expect(v.some((r) => r.includes('cross-municipality'))).toBe(true);
  });

  it('does not treat an unattributed (null) municipality on either side as a mismatch', () => {
    expect(checkInvariants({ postServiceType: 'ELECTRICITY', postMunicipalityId: null, targetMunicipalityId: 'tshwane' })).toEqual([]);
    expect(checkInvariants({ postServiceType: 'ELECTRICITY', postMunicipalityId: 'joburg', targetMunicipalityId: null })).toEqual([]);
  });

  it('refuses to contradict an existing human override', () => {
    const v = checkInvariants({ postServiceType: 'ELECTRICITY', hasHumanOverride: true });
    expect(v.some((r) => r.includes('human LinkOverride'))).toBe(true);
  });

  it('abstains rather than picking between conflicting active lessons', () => {
    const v = checkInvariants({ postServiceType: 'ELECTRICITY', hasConflictingLesson: true });
    expect(v.some((r) => r.includes('conflict'))).toBe(true);
  });

  it('same service, same (or compatible) municipality, no override, no conflict: no violations', () => {
    expect(checkInvariants({ postServiceType: 'WATER', targetServiceType: 'WATER', postMunicipalityId: 'joburg', targetMunicipalityId: 'joburg' })).toEqual([]);
  });
});

describe('eligibilityOf', () => {
  const allowlist = parseAllowlist('disposition-layout-repair@1');

  it('is never eligible in "off" mode', () => {
    const e = eligibilityOf({ policyName: 'disposition-layout-repair', policyVersion: '1', mode: 'off', allowlist });
    expect(e.eligible).toBe(false);
  });

  it('is never eligible in "shadow" mode, even when allowlisted', () => {
    const e = eligibilityOf({ policyName: 'disposition-layout-repair', policyVersion: '1', mode: 'shadow', allowlist });
    expect(e.eligible).toBe(false);
  });

  it('is eligible in "auto" mode only when allowlisted and invariant-clean', () => {
    const e = eligibilityOf({ policyName: 'disposition-layout-repair', policyVersion: '1', mode: 'auto', allowlist });
    expect(e.eligible).toBe(true);
  });

  it('is not eligible in "auto" mode for an unlisted policy version', () => {
    const e = eligibilityOf({ policyName: 'disposition-layout-repair', policyVersion: '2', mode: 'auto', allowlist });
    expect(e.eligible).toBe(false);
    expect(e.reasons.some((r) => r.includes('not on SELF_CORRECTION_POLICIES'))).toBe(true);
  });

  it('an invariant violation blocks eligibility even in "auto" mode with an allowlisted policy', () => {
    const e = eligibilityOf({ policyName: 'disposition-layout-repair', policyVersion: '1', mode: 'auto', allowlist, invariantViolations: ['cross-service: post is WATER, target is ELECTRICITY'] });
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain('cross-service: post is WATER, target is ELECTRICITY');
  });
});

describe('clamp', () => {
  it('never exceeds the configured maximum', () => {
    expect(clamp(15, 10)).toBe(10);
    expect(clamp(3, 10)).toBe(3);
    expect(clamp(-5, 10)).toBe(0);
  });
});
