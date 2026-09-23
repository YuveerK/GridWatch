import { describe, expect, it } from 'vitest';
import { pickParent } from '../../src/modules/infrastructure/infrastructure.service.js';

const node = (id, type) => ({ id, type });
const cand = (id, type) => ({ node: node(id, type) });

describe('pickParent: which candidate a named parent refers to', () => {
  it('a higher-ranked candidate (a substation over its distributor) is the parent', () => {
    const child = node('d', 'DISTRIBUTOR');
    expect(pickParent(child, [cand('s', 'SUBSTATION'), cand('m', 'MINI_SUBSTATION')])).toEqual(cand('s', 'SUBSTATION'));
  });

  it('no higher rank, but a different type: that candidate is still the parent', () => {
    const child = node('c', 'CABLE');
    expect(pickParent(child, [cand('o', 'OTHER')])).toEqual(cand('o', 'OTHER'));
  });

  // Tshwane, 22 Sept: "Hartebeespoort substation tripped, affecting PMP, Yskor Sandwerk and Swartspruit" - all four read as SUBSTATION,
  // yet the post explicitly names Hartebeespoort as each one's parent. A rank-only rule dropped every one of these edges (same rank,
  // same type -> no candidate left), so the post's own stated relationship must not be discarded just because nothing outranks it.
  it('the same type as the child, explicitly named, is trusted as the parent when nothing else fits', () => {
    const child = node('pmp', 'SUBSTATION');
    expect(pickParent(child, [cand('hbp', 'SUBSTATION')])).toEqual(cand('hbp', 'SUBSTATION'));
  });

  it('two equally plausible same-type candidates are genuinely ambiguous: no guess', () => {
    const child = node('x', 'SUBSTATION');
    expect(pickParent(child, [cand('a', 'SUBSTATION'), cand('b', 'SUBSTATION')])).toBeNull();
  });

  it('never the node itself, even when it is its own only "candidate"', () => {
    const child = node('x', 'SUBSTATION');
    expect(pickParent(child, [cand('x', 'SUBSTATION')])).toBeNull();
  });

  it('a higher rank is preferred over an equally-available same-type candidate', () => {
    const child = node('d', 'DISTRIBUTOR');
    expect(pickParent(child, [cand('s', 'SUBSTATION'), cand('d2', 'DISTRIBUTOR')])).toEqual(cand('s', 'SUBSTATION'));
  });

  it('no candidates at all: null', () => {
    expect(pickParent(node('x', 'SUBSTATION'), [])).toBeNull();
  });
});
