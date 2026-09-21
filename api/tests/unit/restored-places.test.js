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

describe('E01: a promise, a condition or an impossibility is not a restoration', () => {
  const affected = () => reading([{ name: 'Alpha', state: 'AFFECTED' }]);
  it.each([
    'Power will be restored to Alpha by 23h00.',
    'Power cannot be restored to Alpha until repairs are complete.',
    'Power can\'t be restored to Alpha yet.',
    'Final tests will be run before supply can be restored to Alpha.',
    'Supply is expected to be restored to Alpha this evening.',
    'The team is working to restore supply; power is expected to be restored to Alpha at 20h00.',
    'Operators are aiming to have power restored to Alpha tonight.',
    'Once repairs are done, power will be restored in Alpha.',
    'Power has not been restored to Alpha.',
    'Power was not restored to Alpha as planned.',
    'City Power said: "power will be restored to Alpha".',
    'The ETR for power restored to Alpha is 22h00.',
    'Alpha is being restored in stages.',
  ])('leaves Alpha affected: %s', (text) => {
    const input = affected();
    expect(markRestoredPlaces(input, text)).toBe(input);
  });
  it.each([
    'Power has been restored to Alpha.',
    'Power has been partially restored to customers in Alpha.',
    'Supply was restored in Alpha at 14h10.',
    'Power restored to Alpha.',
    'Full supply is restored for Alpha after the cable repair.',
  ])('still marks Alpha restored: %s', (text) => {
    expect(markRestoredPlaces(affected(), text).localities[0].state).toBe('RESTORED');
  });
  it('judges each part of a sentence on its own', () => {
    const r = markRestoredPlaces(reading([{ name: 'Alpha', state: 'AFFECTED' }, { name: 'Beta', state: 'AFFECTED' }]), 'Power has been restored to Alpha; supply will be restored to Beta by 23h00.');
    expect(r.localities.map((l) => l.state)).toEqual(['RESTORED', 'AFFECTED']);
  });
  it('a proposed restoration can no longer turn a REPAIRING outage into a RESTORED one', async () => {
    const { statusFor } = await import('../../src/modules/outages/outage-state.js');
    const result = markRestoredPlaces({ status: 'REPAIRING', restoration_percent: null, localities: [{ name: 'Alpha', state: 'AFFECTED' }] }, 'Power will be restored to Alpha by 23h00.');
    expect(statusFor({ result }, 'ACTIVE')).toBe('ACTIVE');
  });
});
