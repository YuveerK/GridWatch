import { describe, expect, it } from 'vitest';
import { foldEffects, keptLifecycleStatus } from '../../src/modules/outages/outage-state.js';
import { foldWaterStatus, waterStateFromText } from '../../src/modules/outages/water-state.js';
import { scoreWaterCandidate } from '../../src/modules/outages/scoring.js';

describe('water operating state', () => {
  it('pumping resumed stays active and recovering', () => {
    const fromText = waterStateFromText('Rand Water pumping has resumed.');
    expect(fromText.waterState).toBe('RECOVERING');
    expect(fromText.customerSupply).toBeNull();
    expect(foldWaterStatus({ waterState: 'RECOVERING' }, 'ACTIVE')).toEqual({ status: 'ACTIVE', waterState: 'RECOVERING' });
  });

  it('a recovery notice is not customer restoration', () => {
    expect(waterStateFromText('Recovery at Helderkruin Reservoir and Tower and Supply Zone').waterState).toBe('RECOVERING');
    expect(waterStateFromText('Johannesburg Water has completed the repairs. The team is recharging the system. Water will not be restored immediately.').customerSupply).toBeNull();
  });

  it('pumping restored to full capacity stays active even when it opens the incident', () => {
    const fromText = waterStateFromText('Update: Eikenhof pumping restored to full capacity');
    expect(fromText).toEqual({ customerSupply: null, waterState: 'RECOVERING' });
    const folded = foldEffects([{
      postId: 'p', postedAt: new Date('2026-09-09T13:38:33Z'), faultIndex: 0,
      effect: { status: 'RESTORED', waterState: 'RECOVERING', customerSupply: null, retroactive: true, locs: [], nodeIds: [], headlineLocalities: [] },
    }]);
    expect(folded.status).toBe('ACTIVE');
    expect(folded.waterState).toBe('RECOVERING');
  });

  it('explicit supply restored is restored and normal', () => {
    expect(waterStateFromText('Water supply has been restored to all affected areas.').customerSupply).toBe('RESTORED');
    expect(foldWaterStatus({ waterState: 'NORMAL', customerSupply: 'RESTORED' }, 'ACTIVE')).toEqual({ status: 'RESTORED', waterState: 'NORMAL' });
  });

  it('partial customer restoration stays partial', () => {
    expect(foldWaterStatus({ customerSupply: 'PARTIAL', waterState: 'LOW_PRESSURE' }, 'ACTIVE').status).toBe('PARTIALLY_RESTORED');
  });

  it('a planned water job keeps the planned lifecycle beside its operating state', () => {
    expect(foldWaterStatus({ status: 'PLANNED', waterState: 'OUTLET_CLOSED' }, 'ACTIVE')).toEqual({ status: 'PLANNED', waterState: 'OUTLET_CLOSED' });
  });
});

describe('a quiet water incident after a later refold', () => {
  const last = new Date('2026-09-01T10:00:00Z');
  it('stays STALE when the timeline is still unresolved and no newer post arrived', () => {
    expect(keptLifecycleStatus({
      foldedStatus: 'ACTIVE', kind: 'UNPLANNED', lastUpdateAt: last,
      previousStatus: 'STALE', previousLastUpdateAt: last,
    })).toBe('STALE');
  });
  it('accepts an explicit restoration discovered while refolding a stale incident', () => {
    expect(keptLifecycleStatus({ foldedStatus: 'RESTORED', kind: 'UNPLANNED', lastUpdateAt: last,
      previousStatus: 'STALE', previousLastUpdateAt: last })).toBe('RESTORED');
  });
  it('becomes live again when a newer post arrives', () => {
    const news = new Date('2026-09-17T10:00:00Z');
    expect(keptLifecycleStatus({
      foldedStatus: 'ACTIVE', kind: 'UNPLANNED', lastUpdateAt: news,
      previousStatus: 'STALE', previousLastUpdateAt: last,
    })).toBe('ACTIVE');
  });
  it('keeps a planned water job planned when the fold only describes its operating condition', () => {
    expect(keptLifecycleStatus({
      foldedStatus: 'ACTIVE', kind: 'PLANNED', lastUpdateAt: last,
      previousStatus: 'ACTIVE', previousLastUpdateAt: last,
    })).toBe('PLANNED');
  });
});

describe('water scoring', () => {
  const post = { kind: 'UNPLANNED', serviceType: 'WATER', conversationId: null, postedAt: new Date(), nodeIds: new Set(['r1']), relatedNodeIds: new Set(), localityIds: new Set(['willowbrook']), waterSystem: null };
  const outage = { kind: 'UNPLANNED', conversationIds: new Set(), nodeIds: new Set(['sub']), localityIds: new Set(['willowbrook']), digest: false, waterSystem: null };

  it('does not confidently link a different asset on suburb overlap alone', () => {
    const scored = scoreWaterCandidate(post, outage);
    expect(scored.score).toBeLessThan(0.35);
    expect(scored.reasons.join(' ')).toMatch(/different water asset/);
  });
});
