import { describe, expect, it } from 'vitest';
import { REASONS, isSampled, priorityOf, quoteAppears } from '../../src/modules/review/suspicion.js';

describe('how urgent an item is', () => {
  it('adds up its reasons; a spot check is the lowest', () => {
    expect(priorityOf([{ code: 'NEW_NEAR_ACTIVE' }, { code: 'UNCERTAIN_READING' }])).toBe(REASONS.NEW_NEAR_ACTIVE.weight + REASONS.UNCERTAIN_READING.weight);
    expect(priorityOf([{ code: 'SAMPLE' }])).toBe(0);
    expect(priorityOf([{ code: 'SOMETHING_NEW' }])).toBe(1); // an unknown reason still counts a little
  });
});

describe('spot checks of clean posts', () => {
  it('are deterministic for a post and a day', () => {
    expect(isSampled('post-1', 0.5, '2026-09-22')).toBe(isSampled('post-1', 0.5, '2026-09-22'));
  });
  it('never at rate 0, always at rate 1, and about the right share in between', () => {
    expect(isSampled('a', 0, '2026-09-22')).toBe(false);
    expect(isSampled('a', 1, '2026-09-22')).toBe(true);
    const hits = Array.from({ length: 2000 }, (_, i) => isSampled(`p${i}`, 0.1, '2026-09-22')).filter(Boolean).length;
    expect(hits).toBeGreaterThan(120);
    expect(hits).toBeLessThan(290);
  });
});

describe('a verifier quote must really be in the source', () => {
  const post = 'Fort Substation: 98% restored. Operators will attend on Monday morning.';
  it('accepts words that are there, whatever the case and spacing', () => {
    expect(quoteAppears('operators will  attend on monday morning', post)).toBe(true);
    expect(quoteAppears('98% restored', 'other', post)).toBe(true);
  });
  it('rejects invented or too-short quotes, and an empty source', () => {
    expect(quoteAppears('power was fully restored at noon', post)).toBe(false);
    expect(quoteAppears('Fort', post)).toBe(false);
    expect(quoteAppears('', post)).toBe(false);
    expect(quoteAppears('some words here', '')).toBe(false);
  });
});
