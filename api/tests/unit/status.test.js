import { describe, expect, it } from 'vitest';
import { statusFor } from '../../src/modules/outages/linker.service.js';

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
});
