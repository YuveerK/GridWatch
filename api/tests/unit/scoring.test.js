import { describe, expect, it } from 'vitest';
import { applyRevivalRule, boardLineOnLiveAssets, sameDayWaterUpdate, scoreCandidate, soleHashtagIncident } from '../../src/modules/outages/scoring.js';

const t0 = new Date('2026-09-16T08:00:00Z');
const hoursLater = (h) => new Date(t0.getTime() + h * 3_600_000);

const outage = (over = {}) => ({
  kind: 'UNPLANNED',
  status: 'ACTIVE',
  nodeIds: new Set(['n1']),
  localityIds: new Set(['l1', 'l2']),
  sdcName: 'Roodepoort',
  conversationIds: new Set(),
  lastUpdateAt: t0,
  restoredAt: null,
  ...over,
});

const post = (over = {}) => ({
  kind: 'UNPLANNED',
  relevance: 'UPDATE',
  status: 'REPAIRING',
  nodeIds: new Set(['n1']),
  relatedNodeIds: new Set(),
  localityIds: new Set(['l1']),
  sdcName: 'Roodepoort',
  conversationId: null,
  postedAt: hoursLater(2),
  ...over,
});

describe('amended posts', () => {
  const other = { nodeIds: new Set(['other']), relatedNodeIds: new Set(), localityIds: new Set(['l1']) };
  it('lifts a same-suburb post with different equipment into the tie-break band, but only when it says it is amended', () => {
    const plain = scoreCandidate(post(other), outage()).score;
    const amended = scoreCandidate(post({ ...other, amended: true }), outage()).score;
    expect(plain).toBeLessThan(0.35); // different equipment, one shared suburb: a new outage
    expect(amended).toBeGreaterThanOrEqual(0.35);
    expect(amended).toBeLessThan(0.7); // still not decided here
  });
  it('does nothing when it shares no suburb or equipment, or the outage is old', () => {
    expect(scoreCandidate(post({ nodeIds: new Set(['x']), localityIds: new Set(['y']), amended: true }), outage()).score).toBe(0);
    expect(scoreCandidate(post({ ...other, amended: true, postedAt: hoursLater(30) }), outage()).score).toBeLessThan(0.35);
  });
});

describe('scoreCandidate', () => {
  it('links an update sharing node and locality with an active outage', () => {
    expect(scoreCandidate(post(), outage()).score).toBeGreaterThanOrEqual(0.7);
  });

  it('scores zero when nothing is shared', () => {
    const r = scoreCandidate(post({ nodeIds: new Set(['x']), localityIds: new Set(['y']) }), outage());
    expect(r.score).toBe(0);
  });

  it('treats a new fault right after restoration as a different outage', () => {
    const restored = outage({ status: 'RESTORED', restoredAt: hoursLater(1), lastUpdateAt: hoursLater(1) });
    const r = scoreCandidate(post({ relevance: 'OUTAGE', postedAt: hoursLater(20) }), restored);
    expect(r.score).toBeLessThan(0.7);
  });

  it('still attaches a restoration post to a recently restored outage', () => {
    const restored = outage({ status: 'RESTORED', restoredAt: hoursLater(1), lastUpdateAt: hoursLater(1) });
    const r = scoreCandidate(post({ relevance: 'RESTORATION', postedAt: hoursLater(2) }), restored);
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });

  it('never links planned with unplanned', () => {
    expect(scoreCandidate(post({ kind: 'PLANNED' }), outage()).score).toBe(0);
  });

  it('penalises a different SDC', () => {
    const r = scoreCandidate(post({ sdcName: 'Midrand' }), outage());
    expect(r.score).toBeLessThan(scoreCandidate(post(), outage()).score);
  });

  it('does not glue a single-node post to a sprawling multi-node outage', () => {
    const big = outage({ nodeIds: new Set(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']), localityIds: new Set() });
    const r = scoreCandidate(post({ localityIds: new Set() }), big);
    expect(r.score).toBeLessThan(0.7);
  });

  it('never attaches a restoration to an outage restored more than 6h earlier', () => {
    const restored = outage({ status: 'RESTORED', restoredAt: hoursLater(1), lastUpdateAt: hoursLater(1) });
    expect(scoreCandidate(post({ relevance: 'RESTORATION', postedAt: hoursLater(9) }), restored).score).toBe(0);
  });

  it('attaches a repeated cancellation to the cancelled outage but not other posts', () => {
    const cancelled = outage({ status: 'CANCELLED' });
    expect(scoreCandidate(post({ status: 'CANCELLED', relevance: 'PLANNED_OUTAGE' }), cancelled).score).toBeGreaterThanOrEqual(0.7);
    expect(scoreCandidate(post(), cancelled).score).toBeLessThan(0.7);
  });

  it('uses the thread as a strong signal', () => {
    const r = scoreCandidate(
      post({ nodeIds: new Set(), localityIds: new Set(['l1']), conversationId: 'c1' }),
      outage({ conversationIds: new Set(['c1']) }),
    );
    expect(r.reasons).toContain('same thread');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe('a suburb-only update of the same area', () => {
  const area = outage({ nodeIds: new Set(['station']), localityIds: new Set(['a', 'b']) });
  const update = { nodeIds: new Set(), relatedNodeIds: new Set(), localityIds: new Set(['a', 'b']), relevance: 'OUTAGE', status: 'INVESTIGATING', postedAt: hoursLater(4) };

  it('links when the update names no equipment and the suburb set matches exactly', () => {
    const r = scoreCandidate(post(update), area);
    expect(r.reasons).toContain('same suburbs, no new equipment');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });

  it('stays a possible new incident when the update names different equipment', () => {
    const r = scoreCandidate(post({ ...update, nodeIds: new Set(['other-station']) }), area);
    expect(r.reasons).not.toContain('same suburbs, no new equipment');
    expect(r.score).toBeLessThan(0.7);
  });

  it('stays a possible new incident when the update names only one shared suburb', () => {
    const r = scoreCandidate(post({ ...update, localityIds: new Set(['a']) }), area);
    expect(r.score).toBeLessThan(0.7);
  });

  it('stays a possible new incident when the update also names other suburbs', () => {
    const r = scoreCandidate(post({ ...update, localityIds: new Set(['a', 'b', 'c']) }), area);
    expect(r.reasons).not.toContain('same suburbs, no new equipment');
    expect(r.score).toBeLessThan(0.7);
  });

  it('never links a planned post to an unplanned incident that covers the same suburbs', () => {
    expect(scoreCandidate(post({ ...update, kind: 'PLANNED', relevance: 'PLANNED_OUTAGE' }), area).score).toBe(0);
  });

  it('links an overnight suburb-only update of the same single suburb (Fontainebleau, 28 Sept)', () => {
    const open = outage({ nodeIds: new Set(), localityIds: new Set(['fontainebleau']), sdcName: 'Randburg' });
    const update = post({
      nodeIds: new Set(),
      localityIds: new Set(['fontainebleau']),
      sdcName: 'Randburg',
      relevance: 'OUTAGE',
      status: 'REPAIRING',
      postedAt: hoursLater(10),
    });
    const scored = scoreCandidate(update, open);
    expect(scored.reasons).toContain('same suburbs, no new equipment');
    expect(scored.score).toBeGreaterThanOrEqual(0.7);
    expect(scoreCandidate(post({ ...update, postedAt: hoursLater(18) }), open).score).toBeLessThan(0.7);
    expect(scoreCandidate(update, outage({ nodeIds: new Set(['station']), localityIds: new Set(['fontainebleau']) })).reasons).not.toContain('same suburbs, no new equipment');
  });

  it('does not apply the electricity suburb rule to a water post', () => {
    const r = scoreCandidate(post({ ...update, serviceType: 'WATER' }), { ...area, serviceType: 'WATER' });
    expect(r.reasons ?? []).not.toContain('same suburbs, no new equipment');
  });
});

describe('a restoration that names different equipment but all the same suburbs', () => {
  it('reaches the tie-break instead of opening a duplicate outage (the Weltevredenpark case)', () => {
    const o = outage({ nodeIds: new Set(['other-station']), localityIds: new Set(['a', 'b', 'c', 'd']) });
    const p = post({ nodeIds: new Set(['jg-strydom']), localityIds: new Set(['a', 'b']), relevance: 'RESTORATION', status: 'RESTORED', postedAt: hoursLater(1) });
    const { score } = scoreCandidate(p, o);
    expect(score).toBeGreaterThanOrEqual(0.35);
    expect(score).toBeLessThan(0.7); // still decided by the tie-break, never linked blindly
  });
  it('a post naming only one shared suburb with different equipment still scores low', () => {
    const o = outage({ nodeIds: new Set(['other-station']), localityIds: new Set(['a', 'b']) });
    const p = post({ nodeIds: new Set(['jg-strydom']), localityIds: new Set(['a']), postedAt: hoursLater(30) });
    expect(scoreCandidate(p, o).score).toBeLessThan(0.35);
  });
});

describe('an outage quiet for a long time', () => {
  const rule = { windowHours: 72, highScore: 0.7 };
  const cand = (over = {}) => ({ status: 'STALE', lastUpdateAt: t0, score: 0.9, reasons: ['shared node x1 (overlap 1.00)'], ...over });
  const post = (h) => ({ postedAt: hoursLater(h) });

  it('within the normal window nothing changes', () => {
    expect(applyRevivalRule(cand(), post(60), rule).score).toBe(0.9);
  });
  it('beyond it, equipment in common is needed, and even then only the tie-break may pick it up (never an automatic link)', () => {
    const r = applyRevivalRule(cand(), post(112), rule);
    expect(r.score).toBeLessThan(0.7);
    expect(r.score).toBeGreaterThanOrEqual(0.35);
    expect(r.reasons.at(-1)).toMatch(/4\.7 days/);
    expect(applyRevivalRule(cand({ reasons: ['locality overlap 100%'] }), post(112), rule).score).toBe(0);
  });
  it('only STALE outages are treated this way', () => {
    expect(applyRevivalRule(cand({ status: 'ACTIVE' }), post(112), rule).score).toBe(0.9);
  });
});

describe('a suburb guessed from a station named after it', () => {
  const different = { nodeIds: new Set(['n9']), localityIds: new Set(['l1']) }; // other equipment, same suburb
  it('is not penalised as "different equipment in the same suburb", so it can reach the tie-break', () => {
    const stated = scoreCandidate(post(different), outage());
    const guessed = scoreCandidate(post({ ...different, localitiesImplied: true }), outage());
    expect(stated.score).toBeLessThan(0.35);
    expect(guessed.score).toBeGreaterThanOrEqual(0.35);
    expect(guessed.score).toBeLessThan(0.7);
  });
});

describe('two distributors under one substation', () => {
  const nodes = (id, type) => ({ id, type });
  it('does not auto-link a different distributor that only shares the substation and the suburb (Cottesmore / Standard Bank)', () => {
    const o = outage({
      nodeIds: new Set(['khanyisa', 'standard-bank']),
      localityIds: new Set(['bryanston']),
      nodes: [nodes('khanyisa', 'SUBSTATION'), nodes('standard-bank', 'DISTRIBUTOR')],
    });
    const p = post({
      nodeIds: new Set(['khanyisa', 'cottesmore']),
      relatedNodeIds: new Set(['khanyisa']),
      localityIds: new Set(['bryanston']),
      nodes: [nodes('khanyisa', 'SUBSTATION'), nodes('cottesmore', 'DISTRIBUTOR')],
      relevance: 'OUTAGE',
      postedAt: hoursLater(1),
    });
    expect(scoreCandidate(p, o).score).toBeLessThan(0.35);
  });
  it('links a same-morning restoration of another distributor at that substation (Bloubosrand, 28 Sept)', () => {
    const o = outage({
      status: 'RESTORED',
      restoredAt: hoursLater(1),
      lastUpdateAt: hoursLater(1),
      nodeIds: new Set(['houtkoppen', 'incomer-2', 'bellairs']),
      localityIds: new Set(['bloubosrand', 'northriding', 'cedar']),
      nodes: [nodes('houtkoppen', 'SUBSTATION'), nodes('incomer-2', 'OTHER'), nodes('bellairs', 'DISTRIBUTOR')],
      sdcName: 'Randburg',
    });
    const p = post({
      relevance: 'RESTORATION',
      status: 'RESTORED',
      nodeIds: new Set(['houtkoppen', 'bloubosrand-dist']),
      localityIds: new Set(['bloubosrand', 'waterford']),
      nodes: [nodes('houtkoppen', 'SUBSTATION'), nodes('bloubosrand-dist', 'DISTRIBUTOR')],
      sdcName: 'Randburg',
      postedAt: hoursLater(4),
    });
    const scored = scoreCandidate(p, o);
    expect(scored.reasons).toContain('restoration under the same substation');
    expect(scored.score).toBeGreaterThanOrEqual(0.7);
  });
  it('still links when both sides name the same distributor', () => {
    const o = outage({
      nodeIds: new Set(['khanyisa', 'cottesmore']),
      localityIds: new Set(['bryanston']),
      nodes: [nodes('khanyisa', 'SUBSTATION'), nodes('cottesmore', 'DISTRIBUTOR')],
    });
    const p = post({
      nodeIds: new Set(['khanyisa', 'cottesmore']),
      localityIds: new Set(['bryanston']),
      nodes: [nodes('khanyisa', 'SUBSTATION'), nodes('cottesmore', 'DISTRIBUTOR')],
      postedAt: hoursLater(1),
    });
    expect(scoreCandidate(p, o).score).toBeGreaterThanOrEqual(0.7);
  });
});

describe('a restoration of a suburb-only outage', () => {
  it('joins a same-day report that named only one suburb (Eagle Canyon, 27 Sept)', () => {
    const open = outage({ nodeIds: new Set(), localityIds: new Set(['eagle']), status: 'ACTIVE' });
    const restoration = post({
      relevance: 'RESTORATION',
      status: 'RESTORED',
      nodeIds: new Set(['sub', 'dist']),
      localityIds: new Set(['eagle']),
      postedAt: hoursLater(4),
    });
    const scored = scoreCandidate(restoration, open);
    expect(scored.reasons).toContain('restoration of the same suburbs');
    expect(scored.score).toBeGreaterThanOrEqual(0.7);
  });

  it('links even when the restoration was posted under a different service centre (Westfield / Elphin Lodge)', () => {
    const o = outage({ nodeIds: new Set(), localityIds: new Set(['elphin', 'rand-aid']), sdcName: 'Alexandra' });
    const p = post({
      nodeIds: new Set(['westfield']),
      localityIds: new Set(['elphin', 'rand-aid']),
      sdcName: 'Midrand',
      relevance: 'RESTORATION',
      status: 'RESTORED',
      postedAt: hoursLater(1.5),
    });
    const r = scoreCandidate(p, o);
    expect(r.reasons).toContain('restoration of the same suburbs');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe('a same-day water notice that names a live reservoir', () => {
  const postAt = hoursLater(8);
  const live = {
    score: 0.44,
    status: 'ACTIVE',
    digest: false,
    nodeIds: new Set(['crosby']),
    nodes: [{ id: 'crosby', type: 'RESERVOIR' }],
    raw: { startedAt: t0 },
  };
  const notice = { serviceType: 'WATER', nodeIds: new Set(['crosby', 'brixton', 'hursthill']), postedAt: postAt };

  it('updates that reservoir (Crosby on the Commando notice, 28 Sept)', () => {
    expect(sameDayWaterUpdate(notice, live)).toBe(true);
  });
  it('does not attach a notice to a weeks-old reservoir or to an upstream pump alone', () => {
    expect(sameDayWaterUpdate(notice, { ...live, raw: { startedAt: hoursLater(-200) } })).toBe(false);
    expect(sameDayWaterUpdate(notice, { ...live, nodeIds: new Set(['eikenhof']), nodes: [{ id: 'eikenhof', type: 'PUMP_STATION' }] })).toBe(false);
    expect(sameDayWaterUpdate(notice, { ...live, digest: true })).toBe(false);
  });
});

describe('water: recent news about the same place', () => {
  // Sundowner, 19-20 Sept: the update on the 500 mm burst named 7 suburbs, 6 of them the incident's; asset read only as a description
  const incident = outage({ serviceType: 'WATER', nodeIds: new Set(), localityIds: new Set(['s1', 's2', 's3', 's4', 's5', 's6', 's7']) });
  const update = (h) => post({ serviceType: 'WATER', nodeIds: new Set(), localityIds: new Set(['s1', 's2', 's3', 's4', 's5', 's6', 'x']), postedAt: hoursLater(h) });

  it('an update the same day reaches the tie-break; the same suburbs weeks later do not score more for it', () => {
    expect(scoreCandidate(update(16), incident).score).toBeGreaterThanOrEqual(0.35);
    expect(scoreCandidate(update(16), incident).score).toBeGreaterThan(scoreCandidate(update(24 * 20), incident).score);
    expect(scoreCandidate(update(24 * 20), incident).score).toBeLessThan(0.35);
  });

  it('recency adds nothing where nothing is shared', () => {
    expect(scoreCandidate(post({ serviceType: 'WATER', nodeIds: new Set(), localityIds: new Set(['elsewhere']), postedAt: hoursLater(1) }), incident).score).toBe(0);
  });
});

describe('water: an update of exactly the same assets', () => {
  it('joins that incident without a tie-break (Florida North Tower, 27 Sept)', () => {
    const tower = outage({ serviceType: 'WATER', nodeIds: new Set(['florida']), localityIds: new Set(), lastUpdateAt: t0 });
    const update = post({ serviceType: 'WATER', nodeIds: new Set(['florida']), localityIds: new Set(), postedAt: hoursLater(21) });
    const scored = scoreCandidate(update, tower);
    expect(scored.reasons).toContain('same water assets');
    expect(scored.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe('water: a deliberate closure on a status board joins the announced planned job', () => {
  // Sandton meters closed 23 Sept 20:00-04:00 SAST (18:00-02:00 UTC); the 17:45 SAST board: "Illovo Reservoir Overnight closure"
  const job = outage({ serviceType: 'WATER', kind: 'PLANNED', status: 'PLANNED', nodeIds: new Set(['illovo', 'bryanston']), localityIds: new Set(), scheduledStart: new Date('2026-09-23T18:00:00Z'), scheduledEnd: new Date('2026-09-24T02:00:00Z'), lastUpdateAt: new Date('2026-09-23T08:00:00Z') });
  const line = (over = {}) => post({ serviceType: 'WATER', kind: 'UNPLANNED', plannedClosure: true, nodeIds: new Set(['illovo']), localityIds: new Set(), postedAt: new Date('2026-09-23T15:47:00Z'), ...over });

  it('same asset, same evening: a candidate (the tie-break decides)', () => {
    const r = scoreCandidate(line(), job);
    expect(r.score).toBeGreaterThanOrEqual(0.35);
    expect(r.reasons).toContain('deliberate closure during the announced planned job');
  });

  it('planned and unplanned still never mix otherwise', () => {
    expect(scoreCandidate(line({ plannedClosure: false }), job).score).toBe(0); // "No pumping." is a fault
    expect(scoreCandidate(line({ nodeIds: new Set(['morningside']) }), job).score).toBe(0); // not an asset of the job
    expect(scoreCandidate(line({ postedAt: new Date('2026-09-25T15:47:00Z') }), job).score).toBe(0); // two days later
    expect(scoreCandidate(line(), { ...job, scheduledStart: null, scheduledEnd: null }).score).toBe(0); // no announced window
  });
});

describe('a later notice that adds a suburb to a suburb-only incident', () => {
  it('links Commercia Extension 09 when the follow-up also names Rabie Ridge (29 Sept)', () => {
    const open = outage({ nodeIds: new Set(), localityIds: new Set(['commercia']), sdcName: 'Midrand' });
    const update = post({
      nodeIds: new Set(),
      localityIds: new Set(['commercia', 'rabie']),
      relevance: 'OUTAGE',
      sdcName: 'Midrand',
      postedAt: hoursLater(2),
    });
    const scored = scoreCandidate(update, open);
    expect(scored.reasons).toContain('same suburbs, no new equipment');
    expect(scored.score).toBeGreaterThanOrEqual(0.7);
  });

  it('does not swallow a long suburb list into a one-suburb incident', () => {
    const open = outage({ nodeIds: new Set(), localityIds: new Set(['commercia']), sdcName: 'Midrand' });
    const bulletin = post({
      nodeIds: new Set(),
      localityIds: new Set(['commercia', 'a', 'b', 'c', 'd']),
      relevance: 'OUTAGE',
      sdcName: 'Midrand',
      postedAt: hoursLater(2),
    });
    expect(scoreCandidate(bulletin, open).score).toBeLessThan(0.7);
  });
});

describe('a graphic that shortens the distributor name', () => {
  const named = (id, type, name) => ({ id, type, name });
  it('links the morning Northcliff line to the overnight Northcliff Ring Main Unit (29 Sept)', () => {
    const open = outage({
      nodeIds: new Set(['roosevelt', 'rmu']),
      localityIds: new Set(['northcliff', 'franklin']),
      nodes: [named('roosevelt', 'SUBSTATION', 'Roosevelt'), named('rmu', 'DISTRIBUTOR', 'Northcliff Ring Main Unit')],
      sdcName: 'Hursthill',
    });
    const graphic = post({
      nodeIds: new Set(['northcliff']),
      localityIds: new Set(['northcliff']),
      nodes: [named('northcliff', 'DISTRIBUTOR', 'Northcliff')],
      relevance: 'OUTAGE',
      sdcName: 'Hursthill',
      postedAt: hoursLater(6),
    });
    const scored = scoreCandidate(graphic, open);
    expect(scored.reasons).toContain('same area, equipment named more loosely');
    expect(scored.score).toBeGreaterThanOrEqual(0.7);
  });

  it('still keeps a different distributor separate (Blackheath vs Northcliff Ring Main Unit)', () => {
    const open = outage({
      nodeIds: new Set(['roosevelt', 'blackheath-dist']),
      localityIds: new Set(['northcliff', 'blackheath', 'berario']),
      nodes: [named('roosevelt', 'SUBSTATION', 'Roosevelt'), named('blackheath-dist', 'DISTRIBUTOR', 'Blackheath')],
      sdcName: 'Hursthill',
    });
    const other = post({
      nodeIds: new Set(['roosevelt', 'rmu']),
      localityIds: new Set(['northcliff', 'franklin']),
      nodes: [named('roosevelt', 'SUBSTATION', 'Roosevelt'), named('rmu', 'DISTRIBUTOR', 'Northcliff Ring Main Unit')],
      relevance: 'OUTAGE',
      sdcName: 'Hursthill',
      postedAt: hoursLater(0.05),
    });
    expect(scoreCandidate(other, open).reasons).not.toContain('same area, equipment named more loosely');
    expect(scoreCandidate(other, open).score).toBeLessThan(0.35);
  });
});

describe('a status-board line for an asset a live incident already has', () => {
  const posted = new Date('2026-09-29T11:12:00Z');
  const line = { serviceType: 'WATER', fromDigest: true, nodeIds: new Set(['brixton-tower']), postedAt: posted };
  const crosby = { id: 'crosby', status: 'ACTIVE', digest: false, nodeIds: new Set(['crosby', 'brixton-tower', 'hursthill']), lastUpdateAt: new Date('2026-09-28T19:21:00Z'), nodes: [] };

  it('joins that incident (Brixton 1 Tower on Crosby, 29 Sept)', () => {
    expect(boardLineOnLiveAssets(line, crosby)).toBe(true);
  });

  it('does not join a digest, a quiet incident, or a line about some other asset', () => {
    expect(boardLineOnLiveAssets(line, { ...crosby, digest: true })).toBe(false);
    expect(boardLineOnLiveAssets(line, { ...crosby, lastUpdateAt: new Date('2026-09-27T00:00:00Z') })).toBe(false);
    expect(boardLineOnLiveAssets({ ...line, nodeIds: new Set(['other']) }, crosby)).toBe(false);
  });

  it('still sees the update that existed when the post was published, after a later post moved the incident forward', () => {
    const later = {
      ...crosby,
      lastUpdateAt: new Date('2026-09-29T18:26:00Z'),
      raw: { posts: [{ postId: 'older', postedAt: new Date('2026-09-28T19:21:00Z') }, { postId: 'newer', postedAt: new Date('2026-09-29T18:26:00Z') }] },
    };
    expect(boardLineOnLiveAssets({ ...line, id: 'board' }, later)).toBe(true);
  });
});

describe('a placeless follow-up whose hashtag names one live incident', () => {
  const posted = new Date('2026-09-29T19:11:00Z');
  const villeria = { id: 'villeria', status: 'ACTIVE', lastUpdateAt: new Date('2026-09-29T09:28:00Z'), nodes: [{ name: 'Njala Infeed' }, { name: 'Watloo' }] };

  it('continues that incident (#NjalaUpdate, 29 Sept)', () => {
    const hit = soleHashtagIncident('#NjalaUpdate: Technicians are experiencing challenges to energise Line 1', [villeria], posted);
    expect(hit.candidate.id).toBe('villeria');
    expect(hit.stem).toBe('njala');
  });

  it('stays unresolved when two live incidents match, or the hashtag matches none', () => {
    const other = { id: 'other', status: 'ACTIVE', lastUpdateAt: villeria.lastUpdateAt, nodes: [{ name: 'Njala West' }] };
    expect(soleHashtagIncident('#NjalaUpdate line 1', [villeria, other], posted)).toBeNull();
    expect(soleHashtagIncident('#CityPowerUpdates something', [villeria], posted)).toBeNull();
  });
});
