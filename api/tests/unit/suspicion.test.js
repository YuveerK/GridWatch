import { describe, expect, it } from 'vitest';
import { REASONS, differentDistributorUnderSharedStation, incidentalAssetOnLargerIncident, isSampled, oneStationInsideRegionalList, operatingUpdateBesidePlannedRepair, plannedProgrammeBesideLiveFault, priorityOf, quoteAppears, sharesOnlyParentStation, sharesOnlyUpstreamPump } from '../../src/modules/review/suspicion.js';

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

describe('a shared parent station with different suburbs', () => {
  const other = {
    nodes: [{ nodeId: 'gresswold', node: { type: 'SUBSTATION' } }],
    localities: [{ localityId: 'bramley' }, { localityId: 'granville' }],
  };
  it('is not a near-duplicate (Gresswold / Wynberg North, 28 Sept)', () => {
    expect(sharesOnlyParentStation(['gresswold'], ['wynberg'], other)).toBe(true);
  });
  it('still counts when a suburb or a reservoir is shared', () => {
    expect(sharesOnlyParentStation(['gresswold'], ['bramley'], other)).toBe(false);
    expect(sharesOnlyParentStation(['illovo'], ['sandton'], { nodes: [{ nodeId: 'illovo', node: { type: 'RESERVOIR' } }], localities: [{ localityId: 'other' }] })).toBe(false);
  });
  it('a shared upstream pump is not a near-duplicate (Palmiet / Eikenhof, 28 Sept)', () => {
    const palmiet = { nodes: [{ nodeId: 'palmiet', node: { type: 'PUMP_STATION' } }, { nodeId: 'illovo', node: { type: 'RESERVOIR' } }] };
    expect(sharesOnlyUpstreamPump(['palmiet', 'rabie'], palmiet)).toBe(true);
    expect(sharesOnlyUpstreamPump(['palmiet', 'illovo'], palmiet)).toBe(false);
  });
});

describe('separate faults the queue should leave alone', () => {
  const node = (nodeId, type) => ({ nodeId, node: { type } });

  it('different distributors under one substation are not a near-duplicate, even with a shared suburb (Roosevelt, 29 Sept)', () => {
    const blackheath = {
      nodes: [node('roosevelt', 'SUBSTATION'), node('blackheath', 'DISTRIBUTOR')],
      localities: [{ localityId: 'northcliff' }, { localityId: 'blackheath' }],
    };
    const rmu = [node('roosevelt', 'SUBSTATION'), node('rmu', 'DISTRIBUTOR')];
    expect(sharesOnlyParentStation(['roosevelt', 'rmu'], ['northcliff'], blackheath)).toBe(false);
    expect(differentDistributorUnderSharedStation(rmu, blackheath)).toBe(true);
    expect(differentDistributorUnderSharedStation(
      [node('roosevelt', 'SUBSTATION'), node('blackheath', 'DISTRIBUTOR')],
      blackheath,
    )).toBe(false);
  });

  it('one station inside a regional list is not a near-duplicate (Mooikloof inside the Njala trip, 29 Sept)', () => {
    const stations = ['njala', 'watloo', 'wingate', 'mooikloof', 'wapadrand', 'lynnwood'].map((id) => id);
    const mooi = { nodes: [node('mooikloof', 'SUBSTATION')], localities: [{ localityId: 'woodlands' }] };
    expect(oneStationInsideRegionalList(stations, ['waltloo', 'mooikloof'], mooi)).toBe(true);
    expect(oneStationInsideRegionalList(['mooikloof'], ['woodlands'], mooi)).toBe(false);
    expect(oneStationInsideRegionalList(stations, ['woodlands'], mooi)).toBe(false);
  });

  it('a planned repair of one reservoir listed on a large unplanned bulletin is not a kind conflict (Hursthill 2, 29 Sept)', () => {
    const crosby = {
      nodes: ['crosby', 'commando', 'eikenhof', 'brixton', 'hursthill1', 'hursthill2'].map((id) => node(id, 'RESERVOIR')),
      localities: [],
    };
    expect(incidentalAssetOnLargerIncident(['hursthill2'], ['melville'], crosby)).toBe(true);
    expect(incidentalAssetOnLargerIncident(['glenanda'], ['glenanda'], { nodes: [node('glenanda', 'SUBSTATION')], localities: [{ localityId: 'glenanda' }] })).toBe(false);
  });

  it('a status line with no suburb is not a kind conflict with a planned repair that names its suburbs (Grand Central, 29 Sept)', () => {
    const planned = { kind: 'PLANNED', localities: [{ localityId: 'halfway' }] };
    expect(operatingUpdateBesidePlannedRepair([], planned)).toBe(true);
    expect(operatingUpdateBesidePlannedRepair(['halfway'], planned)).toBe(false);
    expect(operatingUpdateBesidePlannedRepair([], { kind: 'UNPLANNED', localities: [{ localityId: 'halfway' }] })).toBe(false);
  });

  it('a planned station programme with no suburb is not a kind conflict with the unplanned fault already there (Mooikloof load reduction, 30 Sept)', () => {
    const live = { kind: 'UNPLANNED', localities: [{ localityId: 'woodlands' }] };
    expect(plannedProgrammeBesideLiveFault('PLANNED', [], live)).toBe(true);
    expect(plannedProgrammeBesideLiveFault('UNPLANNED', ['l4'], { kind: 'PLANNED', localities: [{ localityId: 'l4' }] })).toBe(false);
    expect(plannedProgrammeBesideLiveFault('PLANNED', ['woodlands'], live)).toBe(false);
  });
});
