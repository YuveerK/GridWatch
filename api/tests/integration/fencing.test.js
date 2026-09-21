import { beforeEach, describe, expect, it, vi } from 'vitest';

// Never touches X, the AI or a geocoder.
vi.mock('../../src/modules/ai/gemini.client.js', () => ({ generateJson: async () => { throw new Error('no provider in tests'); } }));

const { resolveNode, learnFromExtraction, resetLocalityIndex } = await import('../../src/modules/infrastructure/infrastructure.service.js');
const { ingestNewPosts } = await import('../../src/modules/ingestion/ingestion.service.js');
const { prisma, resetDb } = await import('./db.js');

const T = new Date('2026-09-21T10:00:00Z');
// a worker whose lease is gone from the database, but which has not noticed yet (its in-memory flag still says "held")
const ghost = () => ({ name: 'pipeline', owner: 'expired-owner', lost: false, assertHeld() {} });
const post = (id) => prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: id, text: 't', publishedAt: T, updatedAt: T } });

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EvidenceContribution", "Locality", "WorkLease", "IngestionState" CASCADE');
  resetLocalityIndex();
});

describe('E05: a worker that lost the lease writes nothing, whatever it is writing', () => {
  it('graph learning: no equipment, no evidence and no learned suburb', async () => {
    await post('p1');
    const reading = { result: { sdc: 'Test SDC', entities: [{ type: 'SUBSTATION', name: 'Alpha', parent_name: null }], localities: [{ name: 'Newsuburb', state: 'AFFECTED' }], faults: [] } };
    await expect(learnFromExtraction(reading, T, { source: { postId: 'p1', faultIndex: 0 }, ctx: ghost() })).rejects.toThrow(/lease/i);
    expect(await prisma.infraNode.count()).toBe(0);
    expect(await prisma.evidenceContribution.count()).toBe(0);
    expect(await prisma.locality.count()).toBe(0);
  });

  it('ingestion: a page and its checkpoint are not committed', async () => {
    const page = { posts: [{ tweet: { id: '300', text: 'Alpha outage', created_at: T.toISOString() }, media: [] }], nextToken: null };
    const result = await ingestNewPosts({ ctx: ghost(), fetchPage: async () => page });
    expect(result.status).toBe('FAILED');
    expect(await prisma.sourcePost.count()).toBe(0);
    expect((await prisma.ingestionState.findFirst())?.completedHighWater ?? null).toBeNull();
  });

  it('with no lease context (a script) nothing is checked, as before', async () => {
    const n = await resolveNode({ type: 'SUBSTATION', name: 'Alpha', at: T });
    expect(n.name).toBe('Alpha');
  });
});

describe('E08: a node counter and its evidence record move together', () => {
  it('a failure between them leaves neither, and the retry counts the evidence', async () => {
    await post('p0');
    await post('p1');
    await resolveNode({ type: 'SUBSTATION', name: 'Alpha', at: T, source: { postId: 'p0', faultIndex: 0 } });
    expect((await prisma.infraNode.findFirst()).evidenceCount).toBe(1);

    // make the counter write fail once, after the evidence record was written inside the same transaction
    const original = prisma.$transaction.bind(prisma);
    let failOnce = true;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation((fn, opts) =>
      original(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, key) {
            const value = target[key];
            if (key !== 'infraNode') return value;
            return new Proxy(value, {
              get(node, m) {
                if (m === 'update' && failOnce) {
                  failOnce = false;
                  return async () => { throw new Error('counter write failed'); };
                }
                return typeof node[m] === 'function' ? node[m].bind(node) : node[m];
              },
            });
          },
        });
        return fn(proxy);
      }, opts),
    );
    await expect(resolveNode({ type: 'SUBSTATION', name: 'Alpha', at: T, source: { postId: 'p1', faultIndex: 0 } })).rejects.toThrow('counter write failed');
    spy.mockRestore();
    expect(await prisma.evidenceContribution.count({ where: { postId: 'p1' } })).toBe(0); // rolled back with the counter
    expect((await prisma.infraNode.findFirst()).evidenceCount).toBe(1);

    const retried = await resolveNode({ type: 'SUBSTATION', name: 'Alpha', at: T, source: { postId: 'p1', faultIndex: 0 } });
    expect(retried.evidenceCount).toBe(2);
    expect(retried.lifecycle).toBe('CONFIRMED');
  });

  it('counting the same source twice counts it once', async () => {
    await post('p0');
    await resolveNode({ type: 'SUBSTATION', name: 'Beta', at: T, source: { postId: 'p0', faultIndex: 0 } });
    const again = await resolveNode({ type: 'SUBSTATION', name: 'Beta', at: T, source: { postId: 'p0', faultIndex: 0 } });
    expect(again.evidenceCount).toBe(1);
  });
});
