import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWaterReviewCases, isPairwiseGroupingFile } from '../../src/lib/golden-sets.js';

describe('golden set kinds', () => {
  it('does not treat a water review fixture as a pairwise clustering set', () => {
    const cases = JSON.parse(readFileSync(new URL('../golden/water-reviews.json', import.meta.url), 'utf8'));
    expect(isPairwiseGroupingFile('water-reviews.json', cases)).toBe(false);
    expect(isPairwiseGroupingFile('holdout-0915.json', { _kind: 'holdout', '123456': 'A' })).toBe(true);
    const check = checkWaterReviewCases(cases);
    expect(check.failed).toBe(0);
    expect(check.cases).toBe(3);
  });
});
