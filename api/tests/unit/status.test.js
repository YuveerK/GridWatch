import { describe, expect, it } from 'vitest';
import { linkedToPost, statusFor } from '../../src/modules/outages/linker.service.js';

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
});
