import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider: returns the next queued reply (a JSON string) or throws.
const replies = [];
vi.mock('../../src/modules/ai/gemini.client.js', () => ({
  generateJson: async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { text: JSON.stringify(next), inputTokens: 1, outputTokens: 1 };
  },
}));

const { extractPost, faultLayout, mediaUrl, _fetchImageForTest } = await import('../../src/modules/ai/extraction.service.js');
const { env } = await import('../../src/config/env.js');
const { prisma, resetDb } = await import('./db.js');

const fault = (summary) => ({ status: 'INVESTIGATING', cause: null, eta_text: null, restoration_percent: null, summary, equipment: [], localities: [] });
const reading = (over = {}) => ({
  relevance: 'OUTAGE', sdc: 'X', status: 'INVESTIGATING', cause: null, eta_text: null, restoration_percent: null, entities: [], localities: [], faults: [],
  update_summary: 'one fault', image_text: null, confidence: 0.9, review_reason: null, ...over,
});
const summaries = async () => (await prisma.postSummary.findMany({ orderBy: { faultIndex: 'asc' } })).map((s) => s.summary);

beforeEach(async () => {
  await resetDb();
  replies.length = 0;
  await prisma.sourcePost.create({ data: { id: 'p', platform: 'X', sourceAccount: 'a', externalId: '1', text: 't', publishedAt: new Date(), updatedAt: new Date() } });
});

describe('A15: a reading and its summaries are one unit', () => {
  it('shrinking two faults to one removes the obsolete second summary', async () => {
    replies.push(reading({ faults: [fault('north'), fault('south')] }));
    await extractPost('p', { force: true });
    expect(await summaries()).toEqual(['north', 'south']);
    replies.push(reading({ update_summary: 'just one' }));
    await extractPost('p', { force: true });
    expect(await summaries()).toEqual(['just one']);
  });

  it('a failed re-read keeps the good reading and its summaries', async () => {
    replies.push(reading({ update_summary: 'good' }));
    const good = await extractPost('p');
    replies.push(new Error('provider down'), new Error('provider down')); // both attempts fail
    const again = await extractPost('p', { force: true });
    expect(again.status).toBe('SUCCEEDED');
    expect(again.id).toBe(good.id);
    expect(await summaries()).toEqual(['good']);
  });

  it('a save that fails part-way leaves the old summaries with the old reading', async () => {
    replies.push(reading({ update_summary: 'old' }));
    await extractPost('p');
    // a database rule that rejects the new reading's row AFTER its summaries were written in the same transaction
    await prisma.$executeRawUnsafe(`ALTER TABLE "PostExtraction" ADD CONSTRAINT gw_block CHECK ("imageText" IS DISTINCT FROM 'BLOCKME')`);
    replies.push(reading({ update_summary: 'new', image_text: 'BLOCKME' }));
    await expect(extractPost('p', { force: true })).rejects.toThrow();
    await prisma.$executeRawUnsafe('ALTER TABLE "PostExtraction" DROP CONSTRAINT gw_block');
    expect(await summaries()).toEqual(['old']); // rolled back with the failed reading
  });

  it('summaries carry the prompt version they came from', async () => {
    replies.push(reading());
    await extractPost('p');
    expect((await prisma.postSummary.findFirst()).promptVersion).toBe(env.AI_PROMPT_VERSION);
  });

  it('fault layout is what the linker keys its decisions on', () => {
    expect(faultLayout(reading())).toBe(1);
    expect(faultLayout(reading({ faults: [fault('a'), fault('b'), fault('c')] }))).toBe(3);
    expect(faultLayout(reading({ relevance: 'SDC_SUMMARY', faults: [fault('a')] }))).toBe(1);
  });
});

describe('media fetching is bounded and trusted', () => {
  it('only https twimg hosts are fetched, and the size variant does not break an existing query', () => {
    expect(mediaUrl('https://pbs.twimg.com/media/abc.jpg')).toBe('https://pbs.twimg.com/media/abc.jpg?name=large');
    expect(mediaUrl('https://pbs.twimg.com/media/abc?format=jpg')).toBe('https://pbs.twimg.com/media/abc?format=jpg&name=large');
    expect(mediaUrl('https://pbs.twimg.com/media/abc?format=jpg&name=small')).toContain('name=small');
    expect(() => mediaUrl('http://pbs.twimg.com/x.jpg')).toThrow(/untrusted/);
    expect(() => mediaUrl('https://evil.example.com/x.jpg')).toThrow(/untrusted/);
    expect(() => mediaUrl('https://twimg.com.evil.example/x.jpg')).toThrow(/untrusted/);
  });

  it('stops reading an oversized body as soon as it passes the limit', async () => {
    let produced = 0;
    async function* endless() {
      for (;;) {
        produced += 1_000_000;
        yield Buffer.alloc(1_000_000);
      }
    }
    const fetchFn = async () => ({ ok: true, status: 200, headers: new Headers(), body: Object.assign(endless(), { cancel: async () => {} }) });
    await expect(_fetchImageForTest('https://pbs.twimg.com/a.jpg', { fetchFn })).rejects.toThrow(/too large/);
    expect(produced).toBeLessThanOrEqual(env.MEDIA_MAX_BYTES + 2_000_000);
  });

  it('rejects an oversized declared length without reading the body', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(env.MEDIA_MAX_BYTES + 1) }), body: (async function* () { throw new Error('should not be read'); })() });
    await expect(_fetchImageForTest('https://pbs.twimg.com/a.jpg', { fetchFn })).rejects.toThrow(/too large/);
  });
});

describe('E03: an uncertain re-read is not accepted over a good reading', () => {
  it('a low-confidence forced re-read keeps the accepted reading and its summaries, and says why', async () => {
    replies.push(reading({ update_summary: 'good', confidence: 0.9 }));
    const good = await extractPost('p');
    replies.push(reading({ update_summary: 'shaky', confidence: 0.2, review_reason: 'unclear' }));
    const again = await extractPost('p', { force: true });
    expect(again.keptAfterFailure).toBe(true);
    expect(again.rejectedReason).toMatch(/low confidence/);
    expect(again.id).toBe(good.id);
    expect((await prisma.postExtraction.findUnique({ where: { id: good.id } })).status).toBe('SUCCEEDED');
    expect(await summaries()).toEqual(['good']);
  });
  it('a confident re-read is still accepted', async () => {
    replies.push(reading({ update_summary: 'first' }));
    await extractPost('p');
    replies.push(reading({ update_summary: 'second', confidence: 0.95 }));
    const again = await extractPost('p', { force: true });
    expect(again.keptAfterFailure).toBeUndefined();
    expect(await summaries()).toEqual(['second']);
  });
  it('a first reading that is uncertain is still stored for review (nothing to keep)', async () => {
    replies.push(reading({ confidence: 0.2 }));
    const first = await extractPost('p');
    expect(first.status).toBe('NEEDS_REVIEW');
  });
});

describe('B6: a reading a re-read replaces is kept', () => {
  it('the accepted reading is stored as a revision when a different one replaces it, and not when nothing changed', async () => {
    replies.push(reading({ update_summary: 'first', status: 'INVESTIGATING' }));
    await extractPost('p');
    replies.push(reading({ update_summary: 'same facts, new words', status: 'INVESTIGATING' }));
    await extractPost('p', { force: true });
    expect(await prisma.readingRevision.count()).toBe(0); // only the wording changed: nothing worth keeping
    replies.push(reading({ update_summary: 'now different', status: 'RESTORED' }));
    await extractPost('p', { force: true });
    const kept = await prisma.readingRevision.findMany();
    expect(kept).toHaveLength(1);
    expect(kept[0].result.status).toBe('INVESTIGATING');
    expect(kept[0].revision).toMatch(/^[0-9a-f]{16}$/);
  });
});
