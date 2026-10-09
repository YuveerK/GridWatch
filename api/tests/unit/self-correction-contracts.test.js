import { describe, expect, it } from 'vitest';
import { ActionPayload, EvidenceEnvelope, IllegalTransitionError, idempotencyKeyOf, isTerminal, transition } from '../../src/modules/self-correction/contracts.js';

describe('self-correction lifecycle state machine', () => {
  it('follows the documented happy path', () => {
    let s = 'PROPOSED';
    s = transition(s, 'VERIFYING');
    s = transition(s, 'ELIGIBLE');
    s = transition(s, 'APPLYING');
    s = transition(s, 'APPLIED');
    expect(s).toBe('APPLIED');
    expect(isTerminal(s)).toBe(true);
  });

  it('lets shadow evaluation happen without ever reaching APPLYING', () => {
    let s = transition('PROPOSED', 'SHADOW_EVALUATED');
    s = transition(s, 'VERIFYING');
    expect(transition(s, 'NEEDS_REVIEW')).toBe('NEEDS_REVIEW');
  });

  it('allows any non-terminal, unapplied status to be superseded or expired', () => {
    for (const from of ['PROPOSED', 'SHADOW_EVALUATED', 'VERIFYING', 'ELIGIBLE', 'NEEDS_REVIEW', 'DEFERRED']) {
      expect(transition(from, 'SUPERSEDED')).toBe('SUPERSEDED');
    }
  });

  it('refuses to skip straight from PROPOSED to ELIGIBLE (verification is mandatory)', () => {
    expect(() => transition('PROPOSED', 'ELIGIBLE')).toThrow(IllegalTransitionError);
  });

  it('refuses to apply a proposal that was rejected', () => {
    expect(() => transition('REJECTED', 'APPLYING')).toThrow(IllegalTransitionError);
  });

  it('refuses to move an already-applied proposal anywhere (terminal)', () => {
    expect(() => transition('APPLIED', 'ROLLED_BACK')).toThrow(IllegalTransitionError);
    expect(() => transition('APPLIED', 'SUPERSEDED')).toThrow(IllegalTransitionError);
  });

  it('a failed application can only reach a terminal outcome, never back to ELIGIBLE unattended', () => {
    expect(() => transition('APPLYING', 'ELIGIBLE')).toThrow(IllegalTransitionError);
    expect(transition('APPLYING', 'ROLLED_BACK')).toBe('ROLLED_BACK');
    expect(transition('APPLYING', 'RECOVERY_REQUIRED')).toBe('RECOVERY_REQUIRED');
  });
});

describe('idempotencyKeyOf', () => {
  const base = { postId: 'p1', faultIndex: 0, sourceContentHash: 'abc', sourceLayoutHash: 'xyz', policyName: 'disposition-layout-repair', policyVersion: '1', action: { type: 'REPROCESS_STORED', postId: 'p1', faultIndex: 0 } };

  it('is stable for the same inputs', () => {
    expect(idempotencyKeyOf(base)).toBe(idempotencyKeyOf({ ...base }));
  });

  it('changes when the evidence fingerprint changes (the reading was corrected)', () => {
    expect(idempotencyKeyOf(base)).not.toBe(idempotencyKeyOf({ ...base, sourceContentHash: 'different' }));
  });

  it('changes when the target anchor differs, even for the same action type (two different JOIN targets are two different proposals)', () => {
    const join = (anchorPostId) => idempotencyKeyOf({ ...base, action: { type: 'JOIN_FAULT', postId: 'p1', faultIndex: 0, anchorPostId, anchorFaultIndex: 0 } });
    expect(join('anchorA')).not.toBe(join('anchorB'));
  });
});

describe('contract schemas reject malformed or out-of-union input', () => {
  it('accepts every documented action shape', () => {
    expect(() => ActionPayload.parse({ type: 'REPROCESS_STORED', postId: 'p1', faultIndex: 0 })).not.toThrow();
    expect(() => ActionPayload.parse({ type: 'JOIN_FAULT', postId: 'p1', faultIndex: 0, anchorPostId: 'a1' })).not.toThrow();
    expect(() => ActionPayload.parse({ type: 'SPLIT_FAULT', postId: 'p1', faultIndex: 0 })).not.toThrow();
  });

  it('refuses an action outside the closed union - a model can never invent a new action type', () => {
    expect(() => ActionPayload.parse({ type: 'PATCH_OUTAGE', postId: 'p1', faultIndex: 0, status: 'RESTORED' })).toThrow();
  });

  it('refuses a JOIN_FAULT with no anchor', () => {
    expect(() => ActionPayload.parse({ type: 'JOIN_FAULT', postId: 'p1', faultIndex: 0 })).toThrow();
  });

  it('requires fingerprints on every evidence envelope', () => {
    const action = { type: 'REPROCESS_STORED', postId: 'p1', faultIndex: 0 };
    expect(() => EvidenceEnvelope.parse({ action })).toThrow();
    expect(() =>
      EvidenceEnvelope.parse({ action, fingerprints: { sourceContentHash: 'a', sourceLayoutHash: 'b', lessonSetFingerprint: 'c', candidateStateFingerprint: 'd' } }),
    ).not.toThrow();
  });
});
