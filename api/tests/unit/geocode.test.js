import { describe, expect, it } from 'vitest';
import { inBox, splitRunTogether, stripDirection, stripExt } from '../../src/modules/geo/geocode.service.js';

describe('suburb lookup helpers', () => {
  it('drops extension numbers so "Lenasia Extension 3" is looked up as "Lenasia"', () => {
    expect(stripExt('Lenasia Extension 3')).toBe('Lenasia');
    expect(stripExt('Bramley View Extensions 1')).toBe('Bramley View');
    expect(stripExt('Northcliff')).toBe('Northcliff');
  });
  it('drops a trailing direction or qualifier so "Selby East" falls back to "Selby"', () => {
    expect(stripDirection('Selby East')).toBe('Selby');
    expect(stripDirection('Orange Grove West')).toBe('Orange Grove');
    expect(stripDirection('Sandton')).toBe('Sandton');
    expect(stripDirection('Orlando Ekhaya Flats')).toBe('Orlando Ekhaya');
  });
  it('splits words City Power ran together', () => {
    expect(splitRunTogether('OrlandoEkhaya Flats')).toBe('Orlando Ekhaya Flats');
    expect(splitRunTogether('Northcliff')).toBe('Northcliff');
  });
  it('only accepts positions inside Johannesburg', () => {
    expect(inBox(-26.13, 27.96)).toBe(true);
    expect(inBox(-33.9, 18.4)).toBe(false); // Cape Town
  });
});
