import { describe, expect, it } from 'vitest';
import { isGenericElectricalAsset, localityKey } from '../../src/lib/normalize.js';
import { explicitStationCascade, isDigest } from '../../src/modules/outages/linker.service.js';
import { customerSitesOnIncident, scoreCandidate } from '../../src/modules/outages/scoring.js';

describe('restoration identifies an area-only investigation', () => {
  const at = new Date('2026-09-23T19:49:56Z');
  const post = { postedAt: at, relevance: 'UPDATE', status: 'PARTIALLY_RESTORED', kind: 'UNPLANNED', sdcName: 'Alexandra', nodeIds: new Set(['gresswold', 'lyndhurst']), relatedNodeIds: new Set(), localityIds: new Set(['corlett', 'link', 'drome']), equipmentLocalityIds: new Set(['lyndhurst']) };
  const candidate = { kind: 'UNPLANNED', status: 'ACTIVE', sdcName: 'Alexandra', nodeIds: new Set(), localityIds: new Set(['corlett', 'lyndhurst']), conversationIds: new Set(), lastUpdateAt: new Date('2026-09-23T17:14:10Z') };
  const reason = 'restoration identifies the area-only fault by distributor and suburb';
  it('uses both the remaining suburb and newly identified distributor', () => {
    expect(scoreCandidate(post, candidate).score).toBeGreaterThanOrEqual(0.7);
    expect(scoreCandidate(post, candidate).reasons).toContain(reason);
  });
  it('does not infer continuation from a fresh outage, equipment conflict, missing area or old/different SDC incident', () => {
    for (const incoming of [{ ...post, relevance: 'OUTAGE' }, { ...post, status: 'REPAIRING' }, { ...post, equipmentLocalityIds: new Set() }, { ...post, localityIds: new Set(['other']) }, { ...post, sdcName: 'Randburg' }, { ...post, fromDigest: true }]) {
      expect(scoreCandidate(incoming, candidate).reasons).not.toContain(reason);
    }
    for (const other of [{ ...candidate, nodeIds: new Set(['other']) }, { ...candidate, lastUpdateAt: new Date('2026-09-22T17:14:10Z') }, { ...candidate, lastUpdateAt: new Date('2026-09-23T20:00:00Z') }, { ...candidate, localityIds: new Set(['corlett', 'lyndhurst', 'other']) }]) {
      expect(scoreCandidate(post, other).reasons).not.toContain(reason);
    }
  });
});

describe('descriptive electrical equipment is not a shared identity', () => {
  it('rejects conditions while keeping named sites, routes and equipment labels', () => {
    for (const name of ['faulty cable', 'replacement transformer', 'damaged mini-substation', 'faulty jumpers', 'new mini-substation']) expect(isGenericElectricalAsset(name), name).toBe(true);
    for (const name of ['Allandale', 'Soweto cable', 'RMU 359', 'Feederboard 1A', 'Line D', 'Uys Krige No 1', '275kV Central cable']) expect(isGenericElectricalAsset(name), name).toBe(false);
  });
});

describe('explicit single infeed cascading to secondary substations', () => {
  const entities = [
    { name: 'Njala', type: 'SUBSTATION' },
    { name: 'Waltloo 132kV', type: 'SUBSTATION' },
    ...['Brandwag', 'Propshaft', 'Nellmapius', 'Eersterust', 'Sigma (Ford)', 'Sefatanaga (Ford SEZ)', 'Feltex'].map((name) => ({ name, type: 'SUBSTATION', parent_name: 'Waltloo 132kV' })),
  ];
  const result = { relevance: 'OUTAGE', faults: [], entities };
  const text = '#PowerAlert: Region 6\nNjala Substation\nWaltloo 132kV Sub off affecting the following secondary substations:';
  it('uses source and explicit hierarchy, rather than the nine-node count', () => {
    expect(explicitStationCascade(result, text)).toBe(true);
    expect(isDigest({ nodes: entities, rootCount: 2, singleCascade: true })).toBe(false);
  });
  it('keeps independent assets, several parents, mixed faults and status digests on the existing rules', () => {
    expect(explicitStationCascade(result, 'Nine substations have separate faults.')).toBe(false);
    expect(explicitStationCascade({ ...result, entities: entities.map((e) => ({ ...e, parent_name: null })) }, text)).toBe(false);
    expect(explicitStationCascade({ ...result, faults: [{}, {}] }, text)).toBe(false);
    expect(explicitStationCascade({ ...result, relevance: 'UPDATE' }, text)).toBe(false);
    expect(explicitStationCascade({ ...result, entities: [...entities, { name: 'Other secondary', type: 'SUBSTATION', parent_name: 'Njala' }] }, text)).toBe(false);
    expect(isDigest({ nodes: entities, rootCount: 2 })).toBe(true);
  });
});

describe('customer-site evidence is exact, fault-scoped and chronological', () => {
  const at = new Date('2026-10-01T08:41:36Z');
  const post = { id: 'incoming', customerSites: new Set(['uj soweto campus']), postedAt: at };
  const entry = (extra = {}) => ({ postId: 'prior', postedAt: new Date('2026-10-01T06:04:00Z'), effect: {}, post: { extractions: [{ result: { localities: [{ name: 'UJ Soweto Campus' }] } }] }, ...extra });
  const sites = (rows) => customerSitesOnIncident(post, { raw: { posts: rows } }, localityKey);
  it('recovers an old reading and retains explicit names on a split effect', () => {
    expect([...sites([entry()])]).toEqual(['uj soweto campus']);
    expect([...sites([entry({ effect: { splitFault: true, headlineLocalities: [{ name: 'UJ Soweto Campus' }] }, post: { text: 'An SDC digest.' } })])]).toEqual(['uj soweto campus']);
  });
  it('does not borrow sites from another graphic fault, a future post, itself or a partial name', () => {
    for (const row of [entry({ effect: { splitFault: true } }), entry({ postedAt: new Date('2026-10-01T09:00:00Z') }), entry({ postId: 'incoming' }), entry({ post: { extractions: [{ result: { localities: [{ name: 'UJ Soweto Campus North' }] } }] } })]) {
      expect(sites([row]).size).toBe(0);
    }
    expect(sites([entry({ effect: { splitFault: true, headlineLocalities: [{ name: 'Other Soweto Campus' }] } })]).size).toBe(0);
    const reading = { faults: [{ localities: [{ name: 'UJ Soweto Campus' }] }, { localities: [{ name: 'Kliptown Golf Course' }] }] };
    expect(sites([entry({ effect: { splitFault: true }, faultIndex: 1, post: { extractions: [{ result: reading }] } })]).size).toBe(0);
    expect(sites([entry({ effect: { splitFault: true }, faultIndex: 0, post: { extractions: [{ result: reading }] } })]).size).toBe(1);
  });
  it('site evidence strengthens continued repairs only when the named equipment is shared', () => {
    const incoming = { ...post, kind: 'UNPLANNED', relevance: 'UPDATE', nodeIds: new Set(['soweto']), relatedNodeIds: new Set(), localityIds: new Set() };
    const candidate = { kind: 'UNPLANNED', status: 'ACTIVE', nodeIds: new Set(['soweto']), localityIds: new Set(), customerSites: post.customerSites, conversationIds: new Set(), lastUpdateAt: new Date('2026-10-01T06:04:00Z') };
    expect(scoreCandidate(incoming, candidate).score).toBeGreaterThanOrEqual(0.7);
    expect(scoreCandidate(incoming, { ...candidate, nodeIds: new Set(['allandale']) }).score).toBe(0);
    expect(scoreCandidate({ ...incoming, relevance: 'OUTAGE' }, candidate).reasons).not.toContain('same named customer site and equipment');
    expect(scoreCandidate(incoming, { ...candidate, lastUpdateAt: new Date('2026-09-29T06:00:00Z') }).reasons).not.toContain('same named customer site and equipment');
    const distinct = scoreCandidate({ ...incoming, nodes: [{ id: 'soweto', type: 'SUBSTATION' }, { id: 'a', type: 'DISTRIBUTOR' }], nodeIds: new Set(['soweto', 'a']) }, { ...candidate, nodes: [{ id: 'soweto', type: 'SUBSTATION' }, { id: 'b', type: 'DISTRIBUTOR' }], nodeIds: new Set(['soweto', 'b']) });
    expect(distinct.reasons).not.toContain('same named customer site and equipment');
  });
});
