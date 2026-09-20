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
