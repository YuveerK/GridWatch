import { describe, expect, it } from 'vitest';
import { boxAccepts, boxForMunicipality, inBox, splitRunTogether, stripDirection, stripExt } from '../../src/modules/geo/geocode.service.js';

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

describe('per-municipality bounding box', () => {
  it('Johannesburg always gets its own hand-tuned box, regardless of placed points', () => {
    const box = boxForMunicipality('JOHANNESBURG', []);
    expect(box).toEqual({ south: -26.5, north: -25.8, west: 27.6, east: 28.4 });
  });
  it('a different municipality with too few placed suburbs gets no box (never rejected on that basis)', () => {
    const few = Array.from({ length: 3 }, () => ({ lat: -25.7, lon: 28.2 }));
    expect(boxForMunicipality('TSHWANE', few)).toBeNull();
  });
  it('a different municipality with enough placed suburbs gets a box computed from them, not Johannesburg\'s', () => {
    // Pretoria-area points, well outside the Johannesburg box
    const points = Array.from({ length: 10 }, (_, i) => ({ lat: -25.74 + i * 0.01, lon: 28.19 + i * 0.01 }));
    const box = boxForMunicipality('TSHWANE', points);
    expect(box).not.toBeNull();
    expect(box.south).toBeLessThan(Math.min(...points.map((p) => p.lat)));
    expect(box.north).toBeGreaterThan(Math.max(...points.map((p) => p.lat)));
    // a genuine Pretoria point sits inside its own computed box...
    expect(boxAccepts(box, -25.74, 28.19)).toBe(true);
    // ...but a Johannesburg point does not, and Johannesburg's own box would never have caught that
    expect(boxAccepts(box, -26.2, 28.04)).toBe(false);
  });
  it('boxAccepts never rejects on a null box (not enough is known yet to check)', () => {
    expect(boxAccepts(null, -33.9, 18.4)).toBe(true); // Cape Town: absurd, but nothing here says so yet
  });
});
