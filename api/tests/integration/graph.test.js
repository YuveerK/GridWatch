import { beforeEach, describe, expect, it } from 'vitest';
import { learnFromExtraction, removeContributions, resolveLocality, resetLocalityIndex } from '../../src/modules/infrastructure/infrastructure.service.js';
import { prisma, resetDb } from './db.js';

const at = new Date('2026-09-19T12:00:00Z');
const extraction = (entities, localities = [], sdc = null) => ({ result: { sdc, entities, localities } });
const post = async (id) => prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: id, text: 't', publishedAt: at, updatedAt: at } });

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EvidenceContribution", "Locality" CASCADE');
  resetLocalityIndex();
});

describe('A14: same-name equipment of different types stays distinct', () => {
  it('keeps a Central substation and a Central distributor apart and links them without a self-edge', async () => {
    const r = await learnFromExtraction(extraction([
      { type: 'SUBSTATION', name: 'Central', parent_name: null },
      { type: 'DISTRIBUTOR', name: 'Central', parent_name: 'Central' },
    ]), at);
    expect(r.nodes).toHaveLength(2);
    expect(new Set(r.nodes.map((n) => n.type))).toEqual(new Set(['SUBSTATION', 'DISTRIBUTOR']));
    expect(r.rootCount).toBe(1); // one chain: substation -> distributor
    const edges = await prisma.infraEdge.findMany({ include: { parent: true, child: true } });
    expect(edges).toHaveLength(1);
    expect(edges[0].parent.type).toBe('SUBSTATION');
    expect(edges[0].child.type).toBe('DISTRIBUTOR');
    expect(edges.some((e) => e.parentId === e.childId)).toBe(false);
  });

  it('never guesses between equally plausible parents: an ambiguous name attaches to the service centre instead', async () => {
    const r = await learnFromExtraction(extraction([
      { type: 'FEEDER', name: 'Alpha', parent_name: null },
      { type: 'DISTRIBUTOR', name: 'Alpha', parent_name: null },
      { type: 'TRANSFORMER', name: 'T1', parent_name: 'Alpha' },
    ], [], 'Inner City'), at);
    const t1 = r.nodes.find((n) => n.name.endsWith('T1')); // a bare label is stored with its station: "Alpha T1"
    const parents = await prisma.infraEdge.findMany({ where: { childId: t1.id }, include: { parent: true } });
    expect(parents.map((p) => p.parent.type)).toEqual(['SDC']); // not Alpha-the-feeder, not Alpha-the-distributor
  });

  it('two spellings of one station resolve to one node', async () => {
    const r = await learnFromExtraction(extraction([
      { type: 'SUBSTATION', name: 'Central Substation', parent_name: null },
      { type: 'SWITCHING_STATION', name: 'Central Switching Station', parent_name: null },
    ]), at);
    expect(r.nodes).toHaveLength(1);
  });
});

describe('graph evidence is idempotent per source', () => {
  const chain = () => extraction([
    { type: 'SUBSTATION', name: 'Hub', parent_name: null },
    { type: 'DISTRIBUTOR', name: 'Line 1', parent_name: 'Hub' },
  ], [{ name: 'Testville', state: 'AFFECTED' }], 'Roodepoort');

  const counts = async () => ({
    nodes: Object.fromEntries((await prisma.infraNode.findMany()).map((n) => [n.name, n.evidenceCount])),
    edges: (await prisma.infraEdge.findMany({ orderBy: { evidenceCount: 'asc' } })).map((e) => e.evidenceCount),
    localities: (await prisma.nodeLocality.findMany()).map((l) => l.evidenceCount),
  });

  it('learning the same post twice counts it once', async () => {
    await post('p1');
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    const once = await counts();
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    expect(await counts()).toEqual(once);
  });

  it('a second, different post adds one to each fact', async () => {
    await post('p1');
    await post('p2');
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    const one = await counts();
    await learnFromExtraction(chain(), at, { source: { postId: 'p2', faultIndex: 0 } });
    const two = await counts();
    expect(two.nodes.Hub).toBe(one.nodes.Hub + 1);
    expect(two.localities[0]).toBe(one.localities[0] + 1);
  });

  it('removing a source takes back exactly what it added, and re-learning restores it', async () => {
    await post('p1');
    await post('p2');
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    await learnFromExtraction(chain(), at, { source: { postId: 'p2', faultIndex: 0 } });
    const both = await counts();
    await removeContributions('p2');
    const afterRemove = await counts();
    expect(afterRemove.nodes.Hub).toBe(both.nodes.Hub - 1);
    await learnFromExtraction(chain(), at, { source: { postId: 'p2', faultIndex: 0 } });
    expect(await counts()).toEqual(both);
  });

  it('adopting data counted before records existed (record-only) leaves the counters alone', async () => {
    await learnFromExtraction(chain(), at); // legacy: counted, no records
    const legacy = await counts();
    await post('p1');
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 }, mode: 'record-only' });
    expect(await counts()).toEqual(legacy);
    expect(await prisma.evidenceContribution.count({ where: { postId: 'p1' } })).toBeGreaterThan(0);
    // a later reprocess now takes back exactly one contribution and re-adds it: net zero
    await removeContributions('p1');
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    expect(await counts()).toEqual(legacy);
  });

  it('sibling faults of one post are separate sources', async () => {
    await post('p1');
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 0 } });
    await learnFromExtraction(chain(), at, { source: { postId: 'p1', faultIndex: 1 } });
    expect((await counts()).nodes.Hub).toBe(2); // fault 0 created it (its first evidence), fault 1 is an independent second contribution
    await removeContributions('p1', 1);
    expect((await counts()).nodes.Hub).toBe(1);
  });
});

describe('water: a list of unrelated assets never cross-links their suburbs', () => {
  const water = { serviceType: 'WATER' };
  const loc = (id, name) => prisma.locality.create({ data: { id, canonicalName: name, normalizedName: name.toLowerCase(), active: true, sourceLine: 1, sourceLabel: 'test', updatedAt: at } });
  const pairs = async () => (await prisma.nodeLocality.findMany({ include: { node: true, locality: true } })).map((l) => `${l.node.name} > ${l.locality.canonicalName}`).sort();

  it('the daily throttling notice (11 Sept): each suburb is only its own asset\'s namesake, never linked to the other assets', async () => {
    for (const [id, n] of [['lo', 'Orange Farm'], ['ll', 'Lenasia'], ['lp', 'President Park'], ['ly', 'Yeoville']]) await loc(id, n);
    const r = await learnFromExtraction(extraction([
      { type: 'RESERVOIR', name: 'Orange Farm High Level Reservoir', parent_name: null },
      { type: 'RESERVOIR', name: 'Lenasia High Level Reservoir', parent_name: null },
      { type: 'RESERVOIR', name: 'Lenasia Hospital Hill Reservoir', parent_name: null },
      { type: 'WATER_OTHER', name: 'President Park outlet', parent_name: null },
      { type: 'PUMP_STATION', name: 'Yeoville Pump Station', parent_name: null },
    ], [{ name: 'Orange Farm' }, { name: 'Lenasia' }, { name: 'President Park' }, { name: 'Yeoville' }]), at, water);
    expect(r.rootCount).toBe(5);
    expect(r.localityIds).toHaveLength(4); // the incident still knows the suburbs
    expect(await pairs()).toEqual([
      'Lenasia High Level Reservoir > Lenasia',
      'Lenasia Hospital Hill Reservoir > Lenasia',
      'Orange Farm High Level Reservoir > Orange Farm',
      'President Park outlet > President Park',
      'Yeoville Pump Station > Yeoville',
    ]);
  });

  it('a roll-call of assets: a suburb whose asset the reader left out (11 Sept: "President Park", no outlet listed) teaches nothing', async () => {
    for (const [id, n] of [['lo', 'Orange Farm'], ['ll', 'Lenasia'], ['lp', 'President Park']]) await loc(id, n);
    await learnFromExtraction(extraction([
      { type: 'RESERVOIR', name: 'Orange Farm High Level Reservoir', parent_name: null },
      { type: 'RESERVOIR', name: 'Lenasia High Level Reservoir', parent_name: null },
    ], [{ name: 'Orange Farm' }, { name: 'Lenasia' }, { name: 'President Park' }]), at, water);
    expect(await pairs()).toEqual(['Lenasia High Level Reservoir > Lenasia', 'Orange Farm High Level Reservoir > Orange Farm']);
  });

  it('a short zone list is not a roll-call (4 Sept: "supply zones Hursthill and Brixton" with the Hursthill 2 valve and Crosby PS)', async () => {
    await loc('lh', 'Hursthill');
    await loc('lb', 'Brixton');
    await learnFromExtraction(extraction([
      { type: 'PRV', name: 'Hursthill 2', parent_name: null },
      { type: 'PUMP_STATION', name: 'Crosby Pump Station', parent_name: null },
    ], [{ name: 'Hursthill' }, { name: 'Brixton' }]), at, water);
    expect(await pairs()).toEqual(['Crosby Pump Station > Brixton', 'Hursthill 2 > Brixton', 'Hursthill 2 > Hursthill']);
  });

  it('a real area list with unrelated assets (pipeline burst hitting a reservoir) still teaches the area to both', async () => {
    await loc('lk', 'Kya Sand');
    await learnFromExtraction(extraction([
      { type: 'WATER_PIPELINE', name: 'Lucas Place pipeline', parent_name: null },
      { type: 'RESERVOIR', name: 'Olivedale Reservoir', parent_name: null },
    ], [{ name: 'Kya Sand' }]), at, water);
    expect(await pairs()).toEqual(['Lucas Place pipeline > Kya Sand', 'Olivedale Reservoir > Kya Sand']);
  });

  it('one reservoir with its supply list still learns every suburb', async () => {
    await loc('la', 'Alpha');
    await loc('lb', 'Beta');
    await learnFromExtraction(extraction([{ type: 'RESERVOIR', name: 'Glenvista Reservoir', parent_name: null }], [{ name: 'Alpha' }, { name: 'Beta' }]), at, water);
    expect(await prisma.nodeLocality.count()).toBe(2);
  });

  it('a chain (tower fed by its reservoir) is one asset line, so its leaf learns the suburbs', async () => {
    await loc('la', 'Alpha');
    await learnFromExtraction(extraction([
      { type: 'RESERVOIR', name: 'Brixton Reservoir', parent_name: null },
      { type: 'WATER_TOWER', name: 'Brixton Tower', parent_name: 'Brixton Reservoir', relationType: 'SUPPLIES' },
    ], [{ name: 'Alpha' }]), at, water);
    const links = await prisma.nodeLocality.findMany({ include: { node: true } });
    expect(links.map((l) => l.node.name)).toEqual(['Brixton Tower']);
  });

  it('electricity, Flora Park (Tshwane): "SN line Saartjiesnek, PD line Schuverburg, AE line Elandsfontein" - each line keeps only its own area', async () => {
    for (const [id, n] of [['lf', 'Flora Park'], ['ls', 'Saartjiesnek'], ['lp', 'Schuverburg'], ['le', 'Elandsfontein']]) await loc(id, n);
    await learnFromExtraction(extraction([
      { type: 'LINE', name: 'SN line Saartjiesnek', parent_name: null },
      { type: 'LINE', name: 'PD line Schuverburg', parent_name: null },
      { type: 'LINE', name: 'AE line Elandsfontein', parent_name: null },
    ], [{ name: 'Flora Park' }, { name: 'Saartjiesnek' }, { name: 'Schuverburg' }, { name: 'Elandsfontein' }]), at);
    expect(await pairs()).toEqual(['AE line Elandsfontein > Elandsfontein', 'PD line Schuverburg > Schuverburg', 'SN line Saartjiesnek > Saartjiesnek']);
  });

  it('electricity, Mamelodi 2 (Tshwane): the local areas go to the tripped transformer under Mamelodi 2, not to Hinterland secondary', async () => {
    await loc('lm', 'Mamelodi 2');
    await learnFromExtraction(extraction([
      { type: 'SUBSTATION', name: 'Mamelodi 2', parent_name: null },
      { type: 'TRANSFORMER', name: '132kV transformer 3', parent_name: 'Mamelodi 2' },
      { type: 'SUBSTATION', name: 'Hinterland Secondary', parent_name: null },
    ], [{ name: 'Mamelodi 2' }]), at);
    expect(await pairs()).toEqual(['132kV transformer 3 > Mamelodi 2']);
  });

  it('electricity: two stations sharing one real list of areas still both learn them', async () => {
    await loc('la', 'Alpha');
    await learnFromExtraction(extraction([
      { type: 'SUBSTATION', name: 'Florida North', parent_name: null },
      { type: 'SWITCHING_STATION', name: 'Maraisburg', parent_name: null },
    ], [{ name: 'Alpha' }]), at);
    expect(await prisma.nodeLocality.count()).toBe(2);
  });
});

describe('electrical labels and voltages are not equipment on their own', () => {
  it('Tshepisong: "Line D" and "D" at the switching station are one line; a later "Tshepisong Line D" is the same line', async () => {
    const a = await learnFromExtraction(extraction([{ type: 'SWITCHING_STATION', name: 'Tshepisong', parent_name: null }, { type: 'LINE', name: 'Line D', parent_name: 'Tshepisong' }]), at);
    const b = await learnFromExtraction(extraction([{ type: 'LINE', name: 'Tshepisong Line D', parent_name: null }]), at);
    const lineA = a.nodes.find((n) => n.type === 'LINE');
    expect(lineA.name).toBe('Tshepisong D');
    expect(b.nodes[0].id).toBe(lineA.id);
    const edges = await prisma.infraEdge.findMany({ include: { parent: true, child: true } });
    expect(edges.map((e) => `${e.parent.name} > ${e.child.name}`)).toEqual(['Tshepisong > Tshepisong D']);
  });

  it('Southdale, 26 Sept: a reading that shortened "TSS 65" to "65" is the same site as the earlier "TSS 65"', async () => {
    const earlier = await learnFromExtraction(extraction([{ type: 'OTHER', name: 'TSS 65', parent_name: null }]), at);
    const later = await learnFromExtraction({ result: { sdc: null, entities: [{ type: 'OTHER', name: '65', parent_name: null }], localities: [], image_text: 'Active Outage (s): TSS 65: Efforts to replace the vandalised transformer in Southdale are ongoing.' } }, at);
    expect(later.nodes[0].id).toBe(earlier.nodes[0].id);
    expect(await prisma.infraNode.count()).toBe(1);
  });

  it('a bare "Line C" with no station, and a bare "275kV", are not stored (they would tie unrelated faults together)', async () => {
    const r = await learnFromExtraction(extraction([
      { type: 'LINE', name: 'Line C', parent_name: null },
      { type: 'CABLE', name: '275kV', parent_name: null },
      { type: 'DISTRIBUTOR', name: 'Olivenhout', parent_name: null }, // no station in the post for "Line C" to belong to
    ]), at);
    expect(r.nodes.map((n) => n.name)).toEqual(['Olivenhout']);
    expect(await prisma.infraNode.count()).toBe(1);
  });
});

describe('a mistyped suburb is the suburb, not a new one', () => {
  it('"Develand" resolves to the existing "Devland" instead of creating an unplaced duplicate', async () => {
    await prisma.locality.create({ data: { id: 'devl', canonicalName: 'Devland', normalizedName: 'devland', active: true, sourceLine: 1, sourceLabel: 'Devland', updatedAt: at } });
    resetLocalityIndex();
    const r = await learnFromExtraction(extraction([{ type: 'SUBSTATION', name: 'Hub', parent_name: null }], [{ name: 'Develand', state: 'AFFECTED' }], 'Lenasia'), at);
    expect(r.localityIds).toEqual(['devl']);
    expect(await prisma.locality.count({ where: { normalizedName: 'develand' } })).toBe(0);
  });
});

describe('E09: one street read as a cable, a line and "other" is one thing', () => {
  it('the same name across the minor equipment types resolves to one node, never across a station', async () => {
    const { resolveNode } = await import('../../src/modules/infrastructure/infrastructure.service.js');
    const at = new Date('2026-09-21T10:00:00Z');
    const a = await resolveNode({ type: 'CABLE', name: 'Amanda Avenue', at });
    const b = await resolveNode({ type: 'LINE', name: 'Amanda Avenue', at });
    const c = await resolveNode({ type: 'OTHER', name: 'Amanda Avenue', at });
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    const st = await resolveNode({ type: 'SUBSTATION', name: 'Amanda Avenue', at });
    expect(st.id).not.toBe(a.id);
  });
});
