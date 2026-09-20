import { describe, expect, it } from 'vitest';
import { markRestoredPlaces } from '../../src/lib/restored-places.js';
import { oneEditApart } from '../../src/lib/normalize.js';

const reading = (localities) => ({ status: 'PARTIALLY_RESTORED', localities });

describe('places named in a "restored to" sentence', () => {
  it('marks them restored (the Devland post)', () => {
    const text = 'Eldorado Park Substation, Devland Standby distributor: Power has been partially restored to customers in Develand and surrounding areas. The team is still on site investigating the cause of the outage.';
    const r = markRestoredPlaces(reading([{ name: 'Develand', state: 'AFFECTED' }]), text);
    expect(r.localities[0].state).toBe('RESTORED');
  });
  it('leaves places alone that are only affected', () => {
    const text = 'Power has been restored to Alpha. The outage still affects Beta.';
    const r = markRestoredPlaces(reading([{ name: 'Alpha', state: 'AFFECTED' }, { name: 'Beta', state: 'AFFECTED' }]), text);
    expect(r.localities.map((l) => l.state)).toEqual(['RESTORED', 'AFFECTED']);
  });
  it('does nothing when the sentence says some places are still off', () => {
    const text = 'Power was restored to most customers in Alpha except for Beta.';
    const r = markRestoredPlaces(reading([{ name: 'Alpha', state: 'AFFECTED' }]), text);
    expect(r.localities[0].state).toBe('AFFECTED');
  });
  it('ignores a post that never says restored, and returns the same object when nothing changes', () => {
    const input = reading([{ name: 'Alpha', state: 'AFFECTED' }]);
    expect(markRestoredPlaces(input, 'Operators are investigating an outage in Alpha.')).toBe(input);
  });
  it('copes with a place name that has spaces and odd characters', () => {
    const r = markRestoredPlaces(reading([{ name: "Allen's Nek", state: 'AFFECTED' }]), "Supply has been restored in Allen's Nek and surrounding areas.");
    expect(r.localities[0].state).toBe('RESTORED');
  });
});

describe('a one-letter typo', () => {
  it.each([
    ['develand', 'devland', true],
    ['ferrirasdorp', 'ferreirasdorp', true],
    ['norwood', 'norwoord', true],
    ['sandton', 'sandtonn', true],
    ['sandton', 'sandhurst', false],
    ['norwood', 'norwood', false], // identical is not a typo
    ['abc', 'abd', true],
  ])('%s / %s -> %s', (a, b, expected) => expect(oneEditApart(a, b)).toBe(expected));
});
