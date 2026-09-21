import { describe, expect, it } from 'vitest';
import { initialStatus, isPlanned, linkedToPost, statusFor } from '../../src/modules/outages/linker.service.js';

const ex = (status, states) => ({ result: { status, localities: states.map((state) => ({ name: 'x', state })) } });

describe('statusFor', () => {
  it('treats "restored, but a further fault must be located" as restored when every suburb is restored', () => {
    expect(statusFor(ex('INVESTIGATING', ['RESTORED']), 'ACTIVE')).toBe('RESTORED');
  });
  it('is partially restored when only some suburbs are restored', () => {
    expect(statusFor(ex('REPAIRING', ['RESTORED', 'AFFECTED']), 'ACTIVE')).toBe('PARTIALLY_RESTORED');
  });
  it('keeps a post that itself says partially restored as partial, even if every named suburb is restored', () => {
    expect(statusFor(ex('PARTIALLY_RESTORED', ['RESTORED']), 'ACTIVE')).toBe('PARTIALLY_RESTORED');
  });
  it('stays active when nothing is restored', () => {
    expect(statusFor(ex('REPAIRING', ['AFFECTED']), 'ACTIVE')).toBe('ACTIVE');
    expect(statusFor(ex('REPAIRING', []), null)).toBe('ACTIVE');
  });
  it('a stale outage that gets fresh news is live again', () => {
    expect(statusFor(ex('REPAIRING', ['AFFECTED']), 'STALE')).toBe('ACTIVE');
  });
  it('keeps planned maintenance as planned', () => {
    expect(statusFor(ex('PLANNED', ['AFFECTED']), null)).toBe('PLANNED');
  });

  it('a stated percentage below 100 stays partial even if every named suburb is tagged restored', () => {
    const e = { result: { status: 'REPAIRING', restoration_percent: 48, localities: [{ name: 'a', state: 'RESTORED' }, { name: 'b', state: 'RESTORED' }] } };
    expect(statusFor(e, 'ACTIVE')).toBe('PARTIALLY_RESTORED');
  });
  it('0 percent restored is still an active outage', () => {
    expect(statusFor({ result: { status: 'REPAIRING', restoration_percent: 0, localities: [] } }, 'ACTIVE')).toBe('ACTIVE');
  });
  it('100 percent with a restored headline is restored', () => {
    expect(statusFor({ result: { status: 'RESTORED', restoration_percent: 100, localities: [] } }, 'ACTIVE')).toBe('RESTORED');
  });
});

describe('faults from one graphic', () => {
  const outage = (...postIds) => ({ raw: { posts: postIds.map((postId) => ({ postId })) } });
  it('an outage already holding this post (linked by a sibling fault) is not a candidate for the next fault', () => {
    expect(linkedToPost(outage('p1', 'p2'), 'p2')).toBe(true);
    expect(linkedToPost(outage('p1'), 'p2')).toBe(false);
  });

  it('a restoration post with no outage to join opens a restored outage, unless it says restoration is only partial', () => {
    expect(initialStatus(true, 'RESTORED')).toBe('RESTORED');
    expect(initialStatus(true, 'ACTIVE')).toBe('RESTORED');
    expect(initialStatus(true, 'PARTIALLY_RESTORED')).toBe('PARTIALLY_RESTORED');
    expect(initialStatus(false, 'ACTIVE')).toBe('ACTIVE');
  });

  it('"unplanned power interruption" is not planned work, but "planned power interruption" is', () => {
    const r = (text) => isPlanned({ relevance: 'RESTORATION', result: { status: 'RESTORED' } }, text);
    expect(r('fully restored. This follows an unplanned power interruption caused by a cable fault')).toBe(false);
    expect(r('There was unscheduled maintenance at the site')).toBe(false);
    expect(r('Power restored following the planned power interruption')).toBe(true);
    expect(r('scheduled maintenance is complete')).toBe(true);
  });
});

import { mayBeNewFault } from '../../src/modules/outages/linker.service.js';

describe('a fresh report while the best match is only partly restored', () => {
  const partly = { raw: { status: 'PARTIALLY_RESTORED' }, reasons: ['shared node x1'] };
  const report = { relevance: 'OUTAGE', status: 'INVESTIGATING' };
  it('is asked about, because it may be a new fault (Newtown, 15 Sept)', () => {
    expect(mayBeNewFault(report, partly)).toBe(true);
  });
  it('is not, when it is the same conversation thread, or an ordinary update, or the match is fully live or restored', () => {
    expect(mayBeNewFault(report, { ...partly, reasons: ['same thread'] })).toBe(false);
    expect(mayBeNewFault({ relevance: 'UPDATE', status: 'REPAIRING' }, partly)).toBe(false);
    expect(mayBeNewFault(report, { raw: { status: 'ACTIVE' }, reasons: [] })).toBe(false);
    expect(mayBeNewFault(report, undefined)).toBe(false);
  });
});

describe('what counts as an umbrella graphic (E04)', () => {
  it('a fault already split out of a graphic is never a digest, whatever equipment it names', async () => {
    const { isDigest } = await import('../../src/modules/outages/linker.service.js');
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    expect(isDigest({ fromDigest: true, rootCount: 2, nodes: four })).toBe(false);
    expect(isDigest({ fromDigest: true, rootCount: 5, nodes: four })).toBe(false);
  });
  it('a whole post naming many independent pieces of equipment still is', async () => {
    const { isDigest } = await import('../../src/modules/outages/linker.service.js');
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    expect(isDigest({ fromDigest: false, rootCount: 3, nodes: [] })).toBe(true);
    expect(isDigest({ fromDigest: false, rootCount: 2, nodes: four })).toBe(true);
    expect(isDigest({ fromDigest: false, rootCount: 2, nodes: four.slice(0, 2) })).toBe(false);
  });
});

describe('E06: an overall percentage and explicit per-suburb restoration', () => {
  it('mixed suburb tags stay as stated even with an overall partial percentage', async () => {
    const { foldEffects } = await import('../../src/modules/outages/outage-state.js');
    const eff = (locs, pct) => ({ status: 'PARTIALLY_RESTORED', pct, expand: true, headlineLocalities: locs.map((l) => ({ state: l.restored ? 'RESTORED' : 'AFFECTED' })), locs, nodeIds: [] });
    const folded = foldEffects([{ postId: 'p', postedAt: new Date(), faultIndex: 0, effect: eff([{ id: 'Alpha', restored: true }, { id: 'Beta', restored: false }], 40) }]);
    expect(folded.status).toBe('PARTIALLY_RESTORED');
    expect(folded.localities.get('Alpha')).toBe(true);
    expect(folded.localities.get('Beta')).toBe(false);
  });
  it('but when every suburb is tagged restored and the percentage is partial, the percentage wins', async () => {
    const { foldEffects } = await import('../../src/modules/outages/outage-state.js');
    const e = { status: 'PARTIALLY_RESTORED', pct: 75, expand: true, headlineLocalities: [{ state: 'RESTORED' }, { state: 'RESTORED' }], locs: [{ id: 'X', restored: true }, { id: 'Y', restored: true }], nodeIds: [] };
    const folded = foldEffects([{ postId: 'p', postedAt: new Date(), faultIndex: 0, effect: e }]);
    expect(folded.localities.get('X')).toBe(false);
    expect(folded.localities.get('Y')).toBe(false);
  });
  it('full restoration still restores everyone', async () => {
    const { suburbRestored } = await import('../../src/modules/outages/outage-state.js');
    expect(suburbRestored({ status: 'RESTORED', partial: false, locs: [{ restored: false }], restored: false })).toBe(true);
  });
});

describe('E09: an emergency-isolation programme is one kind of work from its first post to its last', () => {
  const ex = (relevance, status = 'RESTORED') => ({ relevance, result: { status } });
  it('the daily and final posts count as planned even when they are read as an update or a restoration', () => {
    expect(isPlanned(ex('UPDATE'), 'Day 4 of the emergency isolation programme in Glenanda has been successfully completed, with power supply restored.')).toBe(true);
    expect(isPlanned(ex('RESTORATION'), 'Glenanda - Emergency Isolation: Power has been fully restored to all customers who were affected by the emergency isolation.')).toBe(true);
    expect(isPlanned(ex('UPDATE'), 'The isolation programme is progressing well onsite.')).toBe(true);
  });
  it('an ordinary fault, an unplanned interruption and a bare "isolated" are still not', () => {
    expect(isPlanned(ex('RESTORATION'), 'Power has been restored after an unplanned power interruption.')).toBe(false);
    expect(isPlanned(ex('UPDATE'), 'The faulty section has been isolated and repairs continue.')).toBe(false);
    expect(isPlanned(ex('OUTAGE', 'INVESTIGATING'), 'Emergency isolation of the cable was needed after the fault.')).toBe(false); // a fresh fault report is not the programme
  });
});
