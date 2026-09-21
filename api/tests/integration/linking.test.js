import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TIEBREAK_CACHE_FILE = join(mkdtempSync(join(tmpdir(), 'gw-tiebreak-')), 'tiebreak.json'); // never touch the real cache

// The reading the "AI" returns for each post (by post id). No provider is ever called.
const readings = new Map();
vi.mock('../../src/modules/ai/extraction.service.js', async (orig) => ({
  ...(await orig()),
  extractPost: async (postId) => readings.get(postId) ?? { status: 'FAILED', result: null },
}));
// The tie-break "model": always says the first (best-scored) candidate is the same fault. Counts its calls.
const tieBreaks = { calls: 0, pick: 0 };
vi.mock('../../src/modules/ai/gemini.client.js', () => ({
  generateJson: async ({ parts }) => {
    tieBreaks.calls += 1;
    const first = JSON.parse(parts[0].text).candidate_outages[tieBreaks.pick];
    return { text: JSON.stringify({ outage_id: first.outage_id, reason: 'test verdict' }), inputTokens: 0, outputTokens: 0 };
  },
}));
vi.mock('../../src/modules/infrastructure/infrastructure.service.js', async (orig) => {
  const m = await orig();
  return { ...m, learnFromExtraction: async (ex, at, o) => { if (globalThis.__boom?.(ex, o)) throw new Error('boom'); return m.learnFromExtraction(ex, at, o); } };
});

const { processPost, processPending, reprocessPost } = await import('../../src/modules/processing/processor.service.js');
const { sweepStaleOutages } = await import('../../src/modules/outages/linker.service.js');
const { acquireLease, withLease } = await import('../../src/modules/coordination/lease.js');
const { resetLocalityIndex } = await import('../../src/modules/infrastructure/infrastructure.service.js');
const { prisma, resetDb } = await import('./db.js');

const T0 = new Date('2026-09-10T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

const base = { sdc: 'Test SDC', localities: [], faults: [], eta_text: null, cause: null, restoration_percent: null, update_summary: 'x', confidence: 0.9, image_text: null };
const reading = (relevance, status, equipment, extra = {}) => ({
  status: 'SUCCEEDED',
  relevance,
  inputTokens: 0,
  outputTokens: 0,
  result: { ...base, relevance, status, entities: equipment.map((name) => ({ type: 'SUBSTATION', name, parent_name: null })), ...extra },
});
const fault = (status, equipment, extra = {}) => ({ status, cause: null, eta_text: null, restoration_percent: null, summary: 's', equipment: equipment.map((name) => ({ type: 'SUBSTATION', name, parent_name: null })), localities: [], ...extra });

let n = 0;
async function addPost(min, text, r) {
  n += 1;
  const id = `p${n}`;
  await prisma.sourcePost.create({ data: { id, platform: 'X', sourceAccount: 'a', externalId: String(9000 + n), text, publishedAt: at(min), updatedAt: at(min), conversationId: String(9000 + n) } });
  readings.set(id, r);
  return id;
}
const outages = () => prisma.outage.findMany({ include: { posts: true, localities: true }, orderBy: { startedAt: 'asc' } });

beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EvidenceContribution", "Locality", "WorkLease" CASCADE');
  resetLocalityIndex();
  readings.clear();
  globalThis.__boom = null;
  tieBreaks.calls = 0;
  tieBreaks.pick = 0;
  n = 0;
});

describe('A04: the decision commits with the change', () => {
  it('a worker that lost its lease writes nothing: no outage, no timeline entry, no decision', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const ghost = { name: 'pipeline', owner: 'not-the-owner', lost: false, assertHeld() {} };
    await expect(processPost(id, { ctx: ghost })).rejects.toThrow(/lease/i);
    expect(await outages()).toHaveLength(0);
    expect(await prisma.linkDecision.count()).toBe(0);
    expect(await prisma.outagePost.count()).toBe(0);
  });

  it('the same post processed twice at once gives one outage, one decision and one evidence contribution', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const results = await Promise.all([processPost(id), processPost(id)]);
    expect(results.filter((r) => r.outcome === 'BUSY')).toHaveLength(1);
    expect(await outages()).toHaveLength(1);
    expect(await prisma.linkDecision.count()).toBe(1);
    expect((await prisma.infraNode.findFirst({ where: { name: { contains: 'Alpha' } } })).evidenceCount).toBe(1);
  });

  it('a failure while writing the decision undoes the outage and timeline entry too (one transaction)', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    // a database rule that rejects the LinkDecision row, which is the LAST write of the commit
    await prisma.$executeRawUnsafe(`ALTER TABLE "LinkDecision" ADD CONSTRAINT gw_block CHECK ("reason" IS NULL OR "reason" NOT LIKE 'no open candidates%')`);
    try {
      const res = await processPost(id);
      expect(res.outcome).toBe('ERROR');
      expect(await outages()).toHaveLength(0);
      expect(await prisma.outagePost.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "LinkDecision" DROP CONSTRAINT gw_block');
    }
    expect((await processPost(id)).outcome).toBe('NEW'); // and the retry then succeeds exactly once
    expect(await outages()).toHaveLength(1);
  });

  it('a second worker cannot process while the lease is held elsewhere', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await acquireLease('pipeline', 'someone-else', 60_000);
    expect((await processPost(id)).outcome).toBe('BUSY');
    expect(await outages()).toHaveLength(0);
  });

  it('retrying a processed post is a no-op', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(id);
    expect((await processPost(id)).outcome).toBe('ALREADY_LINKED');
    expect(await outages()).toHaveLength(1);
    expect((await prisma.infraNode.findFirst({ where: { name: { contains: 'Alpha' } } })).evidenceCount).toBe(1);
  });
});

describe('A05: multi-fault posts recover per fault', () => {
  const multi = () => reading('OUTAGE', 'INVESTIGATING', [], { faults: [fault('INVESTIGATING', ['North']), fault('INVESTIGATING', ['South']), fault('INVESTIGATING', [])] });

  it('fault 0 succeeds, fault 1 fails, and the retry does only the missing work', async () => {
    const id = await addPost(0, 'graphic', multi());
    globalThis.__boom = (ex) => ex.result.entities.some((e) => /South/.test(e.name));
    const first = await processPost(id);
    expect(first.outcome).toBe('ERROR');
    expect((await prisma.sourcePost.findUnique({ where: { id } })).processingStatus).toBe('PROCESSING_ERROR');
    expect(await outages()).toHaveLength(1); // North is done and kept

    globalThis.__boom = null;
    const pending = await processPending();
    expect(pending.total).toBe(1);
    const decisions = await prisma.linkDecision.findMany({ where: { postId: id }, orderBy: { faultIndex: 'asc' } });
    expect(decisions.map((d) => d.faultIndex)).toEqual([0, 1, 2]);
    expect(await outages()).toHaveLength(2); // one outage per real fault, none duplicated
    expect(decisions[2].reason).toMatch(/no equipment or suburbs/);
    expect((await prisma.infraNode.findFirst({ where: { name: { contains: 'North' } } })).evidenceCount).toBe(1);
  });

  it('a fault that needs review keeps the post flagged, even when a sibling links', async () => {
    const r = reading('OUTAGE', 'INVESTIGATING', [], { faults: [fault('INVESTIGATING', ['North']), fault('INVESTIGATING', ['South'])] });
    const id = await addPost(0, 'graphic', r);
    await prisma.linkDecision.create({ data: { postId: id, faultIndex: 1, outcome: 'NEEDS_REVIEW', reason: 'tie-break failed: x' } });
    await processPost(id);
    expect((await prisma.sourcePost.findUnique({ where: { id } })).processingStatus).toBe('NEEDS_REVIEW');
  });
});

describe('A06: reprocessing replaces the old contribution', () => {
  it('reprocessing an unchanged post changes nothing (outages, links, evidence)', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(id);
    const snap = async () => ({ o: await prisma.outage.count(), p: await prisma.outagePost.count(), d: await prisma.linkDecision.count(), e: (await prisma.infraNode.findMany()).map((x) => x.evidenceCount) });
    const before = await snap();
    await reprocessPost(id);
    await reprocessPost(id);
    expect(await snap()).toEqual(before);
  });

  it('a corrected reading moves the fault: the old outage disappears, unrelated posts are untouched', async () => {
    const keep = await addPost(0, 'Power out at Beta', reading('OUTAGE', 'INVESTIGATING', ['Beta']));
    const moved = await addPost(5, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(keep);
    await processPost(moved);
    expect(await outages()).toHaveLength(2);
    readings.set(moved, reading('OUTAGE', 'INVESTIGATING', ['Gamma']));
    await reprocessPost(moved, { reextract: true });
    const now = await outages();
    expect(now).toHaveLength(2);
    const titles = now.map((o) => o.title).join('|');
    expect(titles).not.toMatch(/Alpha/);
    expect(now.find((o) => o.posts.some((p) => p.postId === keep)).posts).toHaveLength(1);
  });

  it('removing the only post of a two-post outage leaves the outage recomputed from the other', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha'], { cause: 'cable fault' }));
    const b = await addPost(30, 'Alpha restored', reading('RESTORATION', 'RESTORED', ['Alpha']));
    await processPost(a);
    await processPost(b);
    expect((await outages())[0].status).toBe('RESTORED');
    readings.set(b, reading('IRRELEVANT', 'UNKNOWN', []));
    await reprocessPost(b, { reextract: true });
    const [o] = await outages();
    expect(o.status).toBe('ACTIVE'); // the restoration is no longer counted
    expect(o.restoredAt).toBeNull();
    expect(o.posts).toHaveLength(1);
  });
});

describe('A07/A08: state comes from the timeline, not from processing order', () => {
  it('a late older post joins the timeline but does not become the latest word', async () => {
    const open = await addPost(0, 'out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha'], { cause: 'cable fault', eta_text: 'ETA 3pm' }));
    const restored = await addPost(120, 'Alpha restored', reading('RESTORATION', 'RESTORED', ['Alpha']));
    const update = await addPost(60, 'crews on site at Alpha', reading('UPDATE', 'REPAIRING', ['Alpha'], { cause: 'transformer', eta_text: 'ETA 6pm' }));
    for (const id of [open, restored, update]) await processPost(id); // the delayed post is processed last
    const [o] = await outages();
    expect(o.posts).toHaveLength(3);
    expect(o.status).toBe('RESTORED');
    expect(+o.lastUpdateAt).toBe(+at(120));
    expect(+o.restoredAt).toBe(+at(120));
  });

  it('a post from before an outage opened cannot join it', async () => {
    const later = await addPost(100, 'out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(later);
    const earlier = await addPost(10, 'Alpha problem', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(earlier);
    expect(await outages()).toHaveLength(2);
  });

  it('full restoration clears an earlier 48%, and an ordinary update afterwards keeps the original restoration time', async () => {
    const a = await addPost(0, 'out', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(30, 'partly back', reading('UPDATE', 'PARTIALLY_RESTORED', ['Alpha'], { restoration_percent: 48 }));
    const c = await addPost(60, 'all back', reading('RESTORATION', 'RESTORED', ['Alpha']));
    const d = await addPost(90, 'thanks for your patience', reading('UPDATE', 'INVESTIGATING', ['Alpha']));
    for (const id of [a, b, c, d]) await processPost(id);
    const [o] = await outages();
    expect(o.status).toBe('RESTORED');
    expect(o.restorationPercent).toBe(100);
    expect(+o.restoredAt).toBe(+at(60));
  });

  it('a restoration with no outage opens a RESTORED outage that has a restoration time', async () => {
    const id = await addPost(0, 'Alpha restored', reading('RESTORATION', 'UNKNOWN', ['Alpha']));
    await processPost(id);
    const [o] = await outages();
    expect(o.status).toBe('RESTORED');
    expect(+o.restoredAt).toBe(+at(0));
    expect(o.retroactive).toBe(true);
  });
});

describe('A09: planned work is closed only after its window', () => {
  const planned = (text) => reading('PLANNED_OUTAGE', 'PLANNED', ['Alpha'], { update_summary: text });

  it('a notice for a date beyond ten days stays open, then closes after the window', async () => {
    const id = await addPost(0, 'Planned maintenance at Alpha will take place on 30 September 2026 from 09:00-17:00', planned('x'));
    await processPost(id);
    const [o] = await outages();
    expect(o.kind).toBe('PLANNED');
    expect(o.scheduledStart.toISOString()).toBe('2026-09-30T07:00:00.000Z'); // 09:00 Johannesburg
    expect((await sweepStaleOutages(new Date('2026-09-20T00:00:00Z'))).closed).toBe(0);
    expect((await outages())[0].status).toBe('PLANNED');
    await sweepStaleOutages(new Date('2026-10-01T06:00:00Z'));
    expect((await outages())[0].status).toBe('CLOSED');
  });
});

describe('sweep coordination', () => {
  it('is skipped while another worker holds the lease', async () => {
    await acquireLease('pipeline', 'someone-else', 60_000);
    expect(await sweepStaleOutages()).toEqual({ skipped: true });
  });
});

describe('processPending limits and backlog', () => {
  it('limit 0 processes nothing, an exact cap leaves no backlog, a smaller cap reports it', async () => {
    for (let i = 0; i < 3; i++) await addPost(i * 200, `out at S${i}`, reading('OUTAGE', 'INVESTIGATING', [`S${i}`]));
    expect(await processPending({ limit: 0 })).toMatchObject({ total: 0, remaining: 3 });
    expect(await processPending({ limit: 2 })).toMatchObject({ total: 2, remaining: 1 });
    expect(await processPending({ limit: 1 })).toMatchObject({ total: 1, remaining: 0 });
  });

  it('a stale PROCESSING post left by a crashed worker is picked up', async () => {
    const id = await addPost(0, 'out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await prisma.sourcePost.update({ where: { id }, data: { processingStatus: 'PROCESSING' } });
    expect((await processPending()).total).toBe(1);
    expect(await outages()).toHaveLength(1);
  });
});

describe('the lease is released after processing', () => {
  it('nothing is left held', async () => {
    const id = await addPost(0, 'out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(id);
    expect((await withLease('pipeline', async () => 'ok')).acquired).toBe(true);
  });
});

describe('non-outage and multi-fault posts', () => {
  it('awareness posts and customer replies never open or join an outage', async () => {
    const notice = await addPost(0, 'Report cable theft', reading('GENERAL_NOTICE', 'UNKNOWN', ['Alpha']));
    const reply = await addPost(5, '@someone we are looking into it', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const irrelevant = await addPost(10, 'Happy Heritage Day', reading('IRRELEVANT', 'UNKNOWN', []));
    for (const id of [notice, reply, irrelevant]) await processPost(id);
    expect(await outages()).toHaveLength(0);
    expect(await prisma.outagePost.count()).toBe(0);
    expect(await prisma.linkDecision.count()).toBe(3);
  });

  it('a graphic with two faults opens two outages, and a later single-fault update joins only the matching one', async () => {
    const graphic = await addPost(0, 'graphic', reading('OUTAGE', 'INVESTIGATING', [], { faults: [fault('INVESTIGATING', ['North']), fault('INVESTIGATING', ['South'])] }));
    await processPost(graphic);
    expect(await outages()).toHaveLength(2);
    const update = await addPost(20, 'crews at North', reading('UPDATE', 'REPAIRING', ['North']));
    await processPost(update);
    const all = await outages();
    expect(all).toHaveLength(2);
    expect(all.map((o) => o.posts.length).sort()).toEqual([1, 2]);
  });
});

describe('A20: cached tie-breaks keep pointing at the same outage', () => {
  it('two outages opened by sibling faults of one graphic stay distinct across cold and warm cache', async () => {
    const graphic = await addPost(0, 'graphic', reading('OUTAGE', 'INVESTIGATING', [], { faults: [fault('INVESTIGATING', ['North']), fault('INVESTIGATING', ['South'])] }));
    await processPost(graphic);
    const both = await addPost(30, 'North and South update', reading('UPDATE', 'REPAIRING', ['North', 'South']));
    tieBreaks.pick = 1; // the verdict names the SECOND candidate
    const cold = await processPost(both);
    expect(tieBreaks.calls).toBe(1);
    const coldOutage = cold.outageId;
    await reprocessPost(both); // warm cache: no new provider call
    const warm = await prisma.linkDecision.findFirst({ where: { postId: both } });
    expect(tieBreaks.calls).toBe(1);
    expect(warm.outageId).toBe(coldOutage);
    const chosen = await prisma.outage.findUnique({ where: { id: coldOutage }, include: { posts: true } });
    expect(chosen.posts.find((p) => p.postId === graphic).faultIndex).toBe(1); // the second fault's outage, not its sibling
  });

  it('a changed reading is a different question and is asked again', async () => {
    await processPost(await addPost(0, 'out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha'])));
    const q = await addPost(30, 'Alpha again', reading('UPDATE', 'REPAIRING', ['Alpha']));
    await processPost(q);
    expect(tieBreaks.calls).toBe(1);
    readings.set(q, reading('UPDATE', 'REPAIRING', ['Alpha'], { cause: 'a different reading' }));
    await reprocessPost(q, { reextract: true });
    expect(tieBreaks.calls).toBe(2); // the fingerprint changed, so the old verdict was not reused
  });
});


describe('a person\'s correction of a link', () => {
  it('a split keeps a post out of an outage the rules would join, and survives a full rebuild', async () => {
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(30, 'Update at Alpha', reading('UPDATE', 'CREW_ON_SITE', ['Alpha']));
    await processPending();
    expect(await outages()).toHaveLength(1); // the rules join them

    await setOverride({ postId: b, action: 'SPLIT', note: 'a different fault' });
    await reprocessPost(b);
    const split = await outages();
    expect(split).toHaveLength(2);
    expect((await prisma.linkDecision.findFirst({ where: { postId: b } })).reason).toMatch(/manual/);

    // a rebuild from scratch applies the same correction
    const { resetLearnedState } = await import('../../src/modules/processing/processor.service.js');
    await resetLearnedState();
    await processPending();
    expect(await outages()).toHaveLength(2);
    expect(a).toBeTruthy();
  });

  it('a join puts a post into the outage of the anchor post, even when the rules would open a new one', async () => {
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const c = await addPost(20, 'Power out at Zulu', reading('OUTAGE', 'INVESTIGATING', ['Zulu']));
    await processPending();
    expect(await outages()).toHaveLength(2);

    await setOverride({ postId: c, action: 'JOIN', anchorPostId: a });
    await reprocessPost(c);
    const after = await outages();
    expect(after.filter((o) => o.posts.length)).toHaveLength(1);
    expect(after[0].posts.map((p) => p.postId).sort()).toEqual([a, c].sort());
  });

  it('refuses a post joining itself and an unknown action', async () => {
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await expect(setOverride({ postId: a, action: 'JOIN', anchorPostId: a })).rejects.toThrow(/itself/);
    await expect(setOverride({ postId: a, action: 'MOVE' })).rejects.toThrow(/SPLIT or JOIN/);
  });
});

describe('a summary picture that opens with one piece of equipment', () => {
  it('joins that equipment\'s outage on its headline, and never opens an outage of its own', async () => {
    await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const summary = await addPost(720, 'Alpha Substation 90% restored as Beta Substation repairs continue', reading('UPDATE', 'PARTIALLY_RESTORED', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta', 'Zeta', 'Theta', 'Iota']));
    await processPending();
    const all = await outages();
    expect(all).toHaveLength(1);
    expect(all[0].posts.map((p) => p.postId)).toContain(summary);
    expect((await prisma.linkDecision.findFirst({ where: { postId: summary } })).reason).toMatch(/joined on its headline \(Alpha\)/);
  });

  it('a summary whose headline matches nothing open is left alone (no outage opened)', async () => {
    const summary = await addPost(0, 'Alpha Substation 90% restored as Beta Substation repairs continue', reading('UPDATE', 'PARTIALLY_RESTORED', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta', 'Zeta', 'Theta', 'Iota']));
    await processPending();
    expect(await outages()).toHaveLength(0);
    expect(summary).toBeTruthy();
  });
});

describe('an outage that went quiet for days', () => {
  it('is picked up again by a post naming its exact equipment (via the tie-break), and is live again', async () => {
    await addPost(0, 'Vandalism at Alpha, replacement mini substation being procured', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    await prisma.outage.updateMany({ data: { status: 'STALE' } });
    const later = await addPost(5 * 24 * 60, 'Alpha: insurance claim being finalised', reading('UPDATE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    const all = await outages();
    expect(all).toHaveLength(1);
    expect(all[0].posts.map((p) => p.postId)).toContain(later);
    expect(all[0].status).toBe('ACTIVE');
    expect(tieBreaks.calls).toBe(1); // it was the tie-break, not an automatic link
  });

  it('is not touched by a post about different equipment, or once it is older than the revival limit', async () => {
    await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    await prisma.outage.updateMany({ data: { status: 'STALE' } });
    await addPost(5 * 24 * 60, 'Power out at Beta', reading('OUTAGE', 'INVESTIGATING', ['Beta']));
    await addPost(15 * 24 * 60, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    expect(await outages()).toHaveLength(3);
    expect(tieBreaks.calls).toBe(0);
  });
});

describe('a station name misspelled in one post', () => {
  it('is the same station, so its posts stay in one outage (scrambled letters and a missing letter)', async () => {
    const a = await addPost(0, 'Kazerne Substation: fault being located', reading('OUTAGE', 'INVESTIGATING', ['Kazerne']));
    const b = await addPost(60, 'Karzene Substation: power restored to 28%', reading('UPDATE', 'PARTIALLY_RESTORED', ['Karzene']));
    await processPending();
    const all = await outages();
    expect(all).toHaveLength(1);
    expect(all[0].posts.map((p) => p.postId).sort()).toEqual([a, b].sort());
    expect(await prisma.infraNode.count({ where: { type: 'SUBSTATION' } })).toBe(1);
  });
  it('but two stations that differ only in a short label stay two', async () => {
    await addPost(0, 'Lenasia One fault', reading('OUTAGE', 'INVESTIGATING', ['Lenasia Extension 1']));
    await addPost(30, 'Lenasia Two fault', reading('OUTAGE', 'INVESTIGATING', ['Lenasia Extension 2']));
    await processPending();
    expect(await prisma.infraNode.count({ where: { type: 'SUBSTATION' } })).toBe(2);
  });
});

describe('a station named after a suburb', () => {
  it('an outage that named only the suburb and a post that names only the station find each other (via the tie-break)', async () => {
    await addPost(0, 'Outage affecting Halfway House', reading('OUTAGE', 'INVESTIGATING', [], { localities: [{ name: 'Halfway House', state: 'AFFECTED' }] }));
    const b = await addPost(150, 'Operators dispatched to Halfway House', reading('UPDATE', 'CREW_DISPATCHED', ['Halfway House']));
    await processPending();
    const all = await outages();
    expect(all).toHaveLength(1);
    expect(all[0].posts.map((p) => p.postId)).toContain(b);
    expect(tieBreaks.calls).toBe(1); // judged by the tie-break, not linked automatically
  });

  it('a station named after a suburb is never linked automatically to an outage that has its own, different equipment there: only the tie-break may join them', async () => {
    await addPost(0, 'Central substation fault', reading('OUTAGE', 'INVESTIGATING', ['Central'], { localities: [{ name: 'Halfway House', state: 'AFFECTED' }] }));
    const b = await addPost(150, 'Halfway House substation fault', reading('OUTAGE', 'INVESTIGATING', ['Halfway House']));
    await processPending();
    expect(tieBreaks.calls).toBe(1);
    expect((await prisma.linkDecision.findFirst({ where: { postId: b } })).usedLlm).toBe(true);
  });
});

describe('a suburb-named station against an outage with other equipment there', () => {
  it('goes to the tie-break instead of opening a duplicate', async () => {
    await addPost(0, 'Waterfall Substation: fault affecting Halfway House', reading('OUTAGE', 'INVESTIGATING', ['Waterfall'], { localities: [{ name: 'Halfway House', state: 'AFFECTED' }] }));
    const b = await addPost(150, 'Halfway House: 50% restored after a cable fault', reading('UPDATE', 'PARTIALLY_RESTORED', ['Halfway House']));
    await processPending();
    const all = await outages();
    expect(all).toHaveLength(1);
    expect(all[0].posts.map((p) => p.postId)).toContain(b);
    expect(tieBreaks.calls).toBe(1);
  });
});
