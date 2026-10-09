import { describe, expect, it } from 'vitest';
import { releaseGateReport, releaseGateStatus, summarizeByFamily, summarizeByStatus } from '../../src/modules/self-correction/metrics.js';

describe('summarizeByStatus / summarizeByFamily', () => {
  const proposals = [
    { status: 'APPLIED', serviceType: 'ELECTRICITY', sourceAccount: 'CityPowerJhb', policyName: 'disposition-layout-repair', policyVersion: '1' },
    { status: 'APPLIED', serviceType: 'ELECTRICITY', sourceAccount: 'CityPowerJhb', policyName: 'disposition-layout-repair', policyVersion: '1' },
    { status: 'REJECTED', serviceType: 'WATER', sourceAccount: 'JHBWater', policyName: 'quote-restoration', policyVersion: '1' },
  ];

  it('counts by status with raw numerators', () => {
    expect(summarizeByStatus(proposals)).toEqual({ APPLIED: 2, REJECTED: 1 });
  });

  it('breaks down by service/source/policy family, never collapsing distinct families', () => {
    const rows = summarizeByFamily(proposals);
    expect(rows).toHaveLength(2);
    const electricity = rows.find((r) => r.serviceType === 'ELECTRICITY');
    expect(electricity.total).toBe(2);
    expect(electricity.byStatus).toEqual({ APPLIED: 2 });
  });
});

describe('releaseGateStatus', () => {
  it('refuses the gate with zero adjudicated evidence, not a false pass', () => {
    const r = releaseGateStatus({ policyName: 'disposition-layout-repair', policyVersion: '1', adjudicated: null, windowDays: 0 });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('no independently adjudicated proposals exist yet for this policy family');
  });

  it('refuses with fewer than the required sample count, even at 100% accuracy', () => {
    const r = releaseGateStatus({ policyName: 'p', policyVersion: '1', adjudicated: { correct: 50, total: 50, distinctIncidentClusters: 50, criticalMisrepairs: 0 }, windowDays: 30 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('need 200'))).toBe(true);
  });

  it('refuses with enough samples but too short a window', () => {
    const r = releaseGateStatus({ policyName: 'p', policyVersion: '1', adjudicated: { correct: 200, total: 200, distinctIncidentClusters: 200, criticalMisrepairs: 0 }, windowDays: 5 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('need 14'))).toBe(true);
  });

  it('refuses below the accuracy threshold even with enough samples and days', () => {
    const r = releaseGateStatus({ policyName: 'p', policyVersion: '1', adjudicated: { correct: 190, total: 200, distinctIncidentClusters: 200, criticalMisrepairs: 0 }, windowDays: 14 });
    expect(r.eligible).toBe(false);
    expect(r.accuracy).toBeCloseTo(0.95, 2);
  });

  it('refuses unconditionally on any observed critical misrepair, whatever the sample size', () => {
    const r = releaseGateStatus({ policyName: 'p', policyVersion: '1', adjudicated: { correct: 300, total: 300, distinctIncidentClusters: 300, criticalMisrepairs: 1 }, windowDays: 30 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('critical misrepair'))).toBe(true);
  });

  it('passes only when every condition is met', () => {
    const r = releaseGateStatus({ policyName: 'p', policyVersion: '1', adjudicated: { correct: 199, total: 200, distinctIncidentClusters: 200, criticalMisrepairs: 0 }, windowDays: 14 });
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('releaseGateReport', () => {
  it('reports every family, including ones with no evidence at all - abstention is visible, not omitted', () => {
    const families = [{ policyName: 'disposition-layout-repair', policyVersion: '1' }, { policyName: 'quote-restoration', policyVersion: '1' }];
    const report = releaseGateReport(families, new Map(), 0);
    expect(report).toHaveLength(2);
    expect(report.every((r) => !r.eligible)).toBe(true);
  });
});
