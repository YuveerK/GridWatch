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

describe('a mistyped suburb is the suburb, not a new one', () => {
  it('"Develand" resolves to the existing "Devland" instead of creating an unplaced duplicate', async () => {
    await prisma.locality.create({ data: { id: 'devl', canonicalName: 'Devland', normalizedName: 'devland', active: true, sourceLine: 1, sourceLabel: 'Devland', updatedAt: at } });
    resetLocalityIndex();
    const r = await learnFromExtraction(extraction([{ type: 'SUBSTATION', name: 'Hub', parent_name: null }], [{ name: 'Develand', state: 'AFFECTED' }], 'Lenasia'), at);
    expect(r.localityIds).toEqual(['devl']);
    expect(await prisma.locality.count({ where: { normalizedName: 'develand' } })).toBe(0);
  });
});
