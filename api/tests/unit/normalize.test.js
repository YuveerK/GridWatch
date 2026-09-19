import { describe, expect, it } from 'vitest';
import { tailPlace, differsByLabel, infraKey, isNotSuburbName, localityKey, similarity } from '../../src/lib/normalize.js';

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

  it('never treats equipment that differs by a short label or number as the same', () => {
    expect(differsByLabel('tshepisong a', 'tshepisong b')).toBe(true);
    expect(differsByLabel('clover rd 183', 'clover rd 182')).toBe(true);
    expect(differsByLabel('roosevelt park', 'roosevelt')).toBe(false);
    expect(differsByLabel('freedom park', 'freedom prk')).toBe(false);
  });

  it('keeps streets, facilities and companies out of the suburb list but accepts real suburbs', () => {
    for (const bad of ['Marshall Street West', 'Nasturtium Avenue', 'Kya Sand Rd 24', 'Transnet', 'Standby Oil 2', 'Civic Centre', 'Johannesburg Water', 'Sandringham Police Station', '12th to 13th Avenue', 'Newtown, Westgate', 'Elm/Valerie', 'Athol and Barnard', 'Ward 81', 'Prichard 153']) {
      expect(isNotSuburbName(bad), bad).toBe(true);
    }
    for (const good of ['Westdene', 'Houghton', 'Bryanston', 'Northcliff', 'Randjiespark', 'Kya Sand', 'Orange Grove East', 'Lenasia Extension 3', 'Bird Haven']) {
      expect(isNotSuburbName(good), good).toBe(false);
    }
  });

  it('finds the suburb after "in" in a street phrase', () => {
    expect(tailPlace('12th Avenue in Parktown North')).toBe('Parktown North');
    expect(tailPlace('Westdene')).toBeNull();
    expect(tailPlace('customers in')).toBeNull();
  });
});
