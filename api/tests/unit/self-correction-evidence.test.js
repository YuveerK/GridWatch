import { describe, expect, it } from 'vitest';
import { candidateStateFingerprint, fingerprintsChanged, lessonSetFingerprint, sourceContentHash, sourceLayoutHash } from '../../src/modules/self-correction/evidence.js';

const base = { relevance: 'OUTAGE', status: 'INVESTIGATING', entities: [{ type: 'SUBSTATION', name: 'Alpha', parent_name: null }], localities: [{ name: 'Alpha Park', state: 'AFFECTED' }], faults: [] };

describe('sourceContentHash', () => {
  it('is stable for the same reading', () => {
    expect(sourceContentHash(base)).toBe(sourceContentHash({ ...base }));
  });

  it('changes when the reading changes in a way that matters (status)', () => {
    expect(sourceContentHash(base)).not.toBe(sourceContentHash({ ...base, status: 'RESTORED' }));
  });

  it('is a fixed placeholder, never a crash, for no reading at all', () => {
    expect(() => sourceContentHash(null)).not.toThrow();
    expect(sourceContentHash(null)).toBe(sourceContentHash(undefined));
  });
});

describe('sourceLayoutHash', () => {
  it('changes when the fault layout (indices) changes, even if content is identical', () => {
    const extraction = { relevance: 'OUTAGE' };
    const one = sourceLayoutHash(extraction, [{ faultIndex: 0 }]);
    const two = sourceLayoutHash(extraction, [{ faultIndex: 0 }, { faultIndex: 1 }]);
    expect(one).not.toBe(two);
  });

  it('is unaffected by field content changes elsewhere (that is sourceContentHash\'s job)', () => {
    const items = [{ faultIndex: 0 }];
    expect(sourceLayoutHash({ relevance: 'OUTAGE' }, items)).toBe(sourceLayoutHash({ relevance: 'OUTAGE' }, items));
  });
});

describe('candidateStateFingerprint', () => {
  it('is order-independent (same candidates, different array order)', () => {
    const a = [{ stableId: 'x1', score: 0.9 }, { stableId: 'x2', score: 0.3 }];
    const b = [{ stableId: 'x2', score: 0.3 }, { stableId: 'x1', score: 0.9 }];
    expect(candidateStateFingerprint(a)).toBe(candidateStateFingerprint(b));
  });

  it('changes when a candidate\'s score moves meaningfully', () => {
    const a = [{ stableId: 'x1', score: 0.9 }];
    const b = [{ stableId: 'x1', score: 0.2 }];
    expect(candidateStateFingerprint(a)).not.toBe(candidateStateFingerprint(b));
  });

  it('changes when the candidate set itself changes', () => {
    expect(candidateStateFingerprint([{ stableId: 'x1', score: 0.5 }])).not.toBe(candidateStateFingerprint([{ stableId: 'x1', score: 0.5 }, { stableId: 'x2', score: 0.1 }]));
  });
});

describe('lessonSetFingerprint', () => {
  it('changes when a lesson is revised (version bump), not just when the set changes', () => {
    const a = [{ id: 'l1', version: 1 }];
    const b = [{ id: 'l1', version: 2 }];
    expect(lessonSetFingerprint(a)).not.toBe(lessonSetFingerprint(b));
  });
});

describe('fingerprintsChanged', () => {
  const stored = { sourceContentHash: 'a', sourceLayoutHash: 'b', candidateStateFingerprint: 'c', lessonSetFingerprint: 'd' };

  it('is false when nothing moved', () => {
    expect(fingerprintsChanged(stored, { ...stored })).toBe(false);
  });

  it('is true when any single fingerprint moved', () => {
    expect(fingerprintsChanged(stored, { ...stored, sourceContentHash: 'different' })).toBe(true);
    expect(fingerprintsChanged(stored, { ...stored, candidateStateFingerprint: 'different' })).toBe(true);
    expect(fingerprintsChanged(stored, { ...stored, lessonSetFingerprint: 'different' })).toBe(true);
  });

  it('is true (never silently trusted) when there is no fresh envelope at all', () => {
    expect(fingerprintsChanged(stored, null)).toBe(true);
  });
});
