import { describe, expect, it } from 'vitest';
import { tooCloseToCall } from '../../src/modules/outages/linker.service.js';

// Gresswold, 22 Sept: two concurrent, unrelated faults at the same substation scored 0.892 and 0.892 - an exact tie - and the higher one
// alone clearing LINK_HIGH_SCORE picked between them by array order, not by evidence. A close runner-up must send it to the tie-break instead.
const c = (score) => ({ score });

describe('tooCloseToCall: a real runner-up close to the top candidate is not decisive', () => {
  it('an exact tie is too close to call', () => {
    expect(tooCloseToCall([c(0.892), c(0.892)])).toBe(true);
  });
  it('a runner-up within the margin is too close to call', () => {
    expect(tooCloseToCall([c(0.9), c(0.897)])).toBe(true);
  });
  it('a clearly better top candidate is decisive', () => {
    expect(tooCloseToCall([c(0.95), c(0.6)])).toBe(false);
    expect(tooCloseToCall([c(0.9), c(0.88)])).toBe(false); // a real few-hundredths gap is a real difference, not a tie
  });
  it('a runner-up too weak to be a real contender does not count, however close in absolute terms', () => {
    expect(tooCloseToCall([c(0.36), c(0.34)])).toBe(false); // runner-up below LINK_LOW_SCORE
  });
  it('one candidate, or none, is never ambiguous', () => {
    expect(tooCloseToCall([c(0.9)])).toBe(false);
    expect(tooCloseToCall([])).toBe(false);
  });
});
