import { describe, expect, it } from 'vitest';
import { infraKey, localityKey, similarity } from '../../src/lib/normalize.js';

describe('normalize', () => {
  it('strips type words from infrastructure names', () => {
    expect(infraKey('Peter Road Substation')).toBe('peter road');
    expect(infraKey('Ruimsig Switching Station')).toBe('ruimsig');
    expect(infraKey('Clover Rd Distributor')).toBe('clover rd');
  });

  it('normalizes locality extensions and punctuation', () => {
    expect(localityKey('Beverley Ext.1 & 2')).toBe(localityKey('beverley extension1 and 2'));
    expect(localityKey('Lenasia South Ext 4')).toBe('lenasia south ext 4');
  });

  it('computes similarity', () => {
    expect(similarity('clover rd', 'clover rd')).toBe(1);
    expect(similarity('freedom park', 'freedom prk')).toBeGreaterThan(0.8);
    expect(similarity('abc', 'xyz')).toBe(0);
  });
});
