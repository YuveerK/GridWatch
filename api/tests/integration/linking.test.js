import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TIEBREAK_CACHE_FILE = join(mkdtempSync(join(tmpdir(), 'gw-tiebreak-')), 'tiebreak.json'); // never touch the real cache

// The reading the "AI" returns for each post (by post id). No provider is ever called.
const readings = new Map();
vi.mock('../../src/modules/ai/extraction.service.js', async (orig) => ({
  ...(await orig()),
  extractPost: async (postId) => {
    await globalThis.__gate?.(postId); // a test can hold a read open to make two workers overlap for certain
    return readings.get(postId) ?? { status: 'FAILED', result: null };
  },
}));
// The tie-break "model": always says the first (best-scored) candidate is the same fault. Counts its calls.
process.env.TIEBREAK_RETRY_DELAYS_MS = '1,1'; // the in-call retries of a temporary failure wait milliseconds in tests
const tieBreaks = { calls: 0, pick: 0, fail: null }; // fail: a message makes every tie-break throw it
vi.mock('../../src/modules/ai/gemini.client.js', () => ({
  generateJson: async ({ parts }) => {
    tieBreaks.calls += 1;
    if (tieBreaks.fail) throw new Error(tieBreaks.fail);
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
  tieBreaks.fail = null;
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

  it('the same post processed while another worker is mid-way is refused (BUSY), leaving one outage, decision and contribution', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    let entered;
    const inside = new Promise((r) => (entered = r));
    let release;
    const hold = new Promise((r) => (release = r));
    globalThis.__gate = async () => { entered(); await hold; };
    const first = processPost(id);
    await inside; // the first worker is now certainly inside, holding the lease
    globalThis.__gate = undefined;
    const second = await processPost(id);
    expect(second.outcome).toBe('BUSY');
    release();
    expect((await first).outcome).not.toBe('BUSY');
    expect(await outages()).toHaveLength(1);
    expect(await prisma.linkDecision.count()).toBe(1);
    expect((await prisma.infraNode.findFirst({ where: { name: { contains: 'Alpha' } } })).evidenceCount).toBe(1);
  });

  it('the same post processed twice one after the other adds nothing the second time', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPost(id);
    await processPost(id);
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


describe('two candidates too close to call: score alone must not decide by array order (Gresswold, 22 Sept)', () => {
  it('an exact tie between two live outages at the same equipment goes to the tie-break, not to whichever sorts first', async () => {
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    // two SEPARATE, concurrent faults at the same substation, in different (non-overlapping) suburbs, opened moments apart
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha'], { localities: [{ name: 'North', state: 'AFFECTED' }] }));
    await processPost(a);
    const b = await addPost(0, 'Power out at Alpha too', reading('OUTAGE', 'INVESTIGATING', ['Alpha'], { localities: [{ name: 'South', state: 'AFFECTED' }] }));
    await setOverride({ postId: b, action: 'SPLIT' }); // a person already established these are two distinct faults
    await processPost(b);
    expect(await outages()).toHaveLength(2);
    // a third update names only the shared equipment, no suburb either existing outage claims: both score identically (shared node alone)
    const c = await addPost(0, 'Alpha update', reading('UPDATE', 'REPAIRING', ['Alpha'], { localities: [{ name: 'East', state: 'AFFECTED' }] }));
    tieBreaks.pick = 0;
    const r = await processPost(c);
    expect(tieBreaks.calls).toBe(1); // decided by the tie-break, not silently picked
    expect(r.detail.usedLlm).toBe(true);
    expect(await outages()).toHaveLength(2); // still two distinct faults: nothing was invented or merged by a coin flip
  });

  it('a clearly better candidate is still picked deterministically (no needless tie-break)', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha'], { localities: [{ name: 'North', state: 'AFFECTED' }] }));
    await processPost(a);
    const b = await addPost(60, 'Alpha update', reading('UPDATE', 'REPAIRING', ['Alpha'], { localities: [{ name: 'North', state: 'AFFECTED' }] }));
    const r = await processPost(b);
    expect(tieBreaks.calls).toBe(0);
    expect(r.detail.usedLlm).toBe(false);
    expect(await outages()).toHaveLength(1);
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

describe('planned work closed by a wrong date', () => {
  it('is opened again when its window is corrected to a date still ahead', async () => {
    const { refoldOutage } = await import('../../src/modules/outages/outage-state.js');
    const p = await addPost(0, 'Planned work at Alpha', reading('PLANNED_OUTAGE', 'PLANNED', ['Alpha']));
    const o = await prisma.outage.create({ data: { kind: 'PLANNED', status: 'CLOSED', title: 'Alpha', startedAt: at(0), lastUpdateAt: at(0) } });
    const future = new Date(Date.now() + 2 * 24 * 3_600_000);
    const effect = { status: 'PLANNED', pct: null, cause: null, eta: null, headlineLocalities: [], locs: [], nodeIds: [], expand: true, retroactive: false, schedule: { start: future.toISOString(), end: new Date(future.getTime() + 8 * 3_600_000).toISOString() } };
    await prisma.outagePost.create({ data: { outageId: o.id, postId: p, role: 'OPENED', postedAt: at(0), effect } });
    await prisma.$transaction((tx) => refoldOutage(tx, o.id));
    expect((await prisma.outage.findUnique({ where: { id: o.id } })).status).toBe('PLANNED');
  });
  it('but planned work whose window has really passed stays closed', async () => {
    const { refoldOutage } = await import('../../src/modules/outages/outage-state.js');
    const p = await addPost(0, 'Planned work at Beta', reading('PLANNED_OUTAGE', 'PLANNED', ['Beta']));
    const o = await prisma.outage.create({ data: { kind: 'PLANNED', status: 'CLOSED', title: 'Beta', startedAt: at(0), lastUpdateAt: at(0) } });
    const past = new Date(Date.now() - 3 * 24 * 3_600_000);
    const effect = { status: 'PLANNED', pct: null, cause: null, eta: null, headlineLocalities: [], locs: [], nodeIds: [], expand: true, retroactive: false, schedule: { start: past.toISOString(), end: new Date(past.getTime() + 8 * 3_600_000).toISOString() } };
    await prisma.outagePost.create({ data: { outageId: o.id, postId: p, role: 'OPENED', postedAt: at(0), effect } });
    await prisma.$transaction((tx) => refoldOutage(tx, o.id));
    expect((await prisma.outage.findUnique({ where: { id: o.id } })).status).toBe('CLOSED');
  });
});

describe('a post held back because its picture would not download', () => {
  it('is read again a few minutes later and linked, but only within the retry window', async () => {
    const { retryImageFailures } = await import('../../src/modules/processing/processor.service.js');
    const id = await addPost(0, 'Power out at Alpha', { ...reading('OUTAGE', 'INVESTIGATING', ['Alpha']), status: 'NEEDS_REVIEW', error: '1 image(s) could not be fetched (image 404)' });
    await processPending();
    expect((await prisma.sourcePost.findUnique({ where: { id } })).processingStatus).toBe('NEEDS_REVIEW');
    await prisma.postExtraction.create({ data: { postId: id, promptVersion: 'v', model: 'm', status: 'NEEDS_REVIEW', relevance: 'OUTAGE', error: '1 image(s) could not be fetched (image 404)' } });

    // too fresh (the first attempt just happened) and too old (a picture that is really gone): left alone
    expect(await retryImageFailures({ now: at(1) })).toEqual({ tried: 0, fixed: 0 });
    expect(await retryImageFailures({ now: at(120) })).toEqual({ tried: 0, fixed: 0 });

    // the picture is there now: the next read succeeds
    readings.set(id, reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    expect(await retryImageFailures({ now: at(10) })).toEqual({ tried: 1, fixed: 1 });
    expect((await prisma.sourcePost.findUnique({ where: { id } })).processingStatus).toBe('RELEVANT');
    expect(await outages()).toHaveLength(1);
    expect(await retryImageFailures({ now: at(10) })).toEqual({ tried: 0, fixed: 0 }); // done: nothing left to retry
  });
});

describe('E02: re-processing a post puts it back where it was', () => {
  const membership = async () => (await outages()).map((o) => o.posts.map((p) => p.postId).sort()).sort();
  const three = async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(1, 'Alpha crew on site', reading('UPDATE', 'CREW_ON_SITE', ['Alpha']));
    const c = await addPost(90, 'Alpha repairs continue', reading('UPDATE', 'REPAIRING', ['Alpha']));
    await processPending();
    return { a, b, c };
  };
  it('the opening post, when a second post came a minute after it, joins the same outage (it used to open a second one)', async () => {
    const { a } = await three();
    const before = await membership();
    expect(before).toHaveLength(1);
    await reprocessPost(a);
    expect(await membership()).toEqual(before);
  });
  it('the same for a middle post, the latest post, and doing it twice', async () => {
    const { b, c } = await three();
    const before = await membership();
    await reprocessPost(b);
    expect(await membership()).toEqual(before);
    await reprocessPost(c);
    await reprocessPost(c);
    expect(await membership()).toEqual(before);
  });
  it('a post that really belonged to nothing before is not forced into an outage by the repair rule', async () => {
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const z = await addPost(2, 'Power out at Zulu', reading('OUTAGE', 'INVESTIGATING', ['Zulu']));
    await processPending();
    await reprocessPost(a);
    expect(await outages()).toHaveLength(2);
    expect(z).toBeTruthy();
  });
  it('a post published before an unrelated outage opened still cannot join it (the temporal rule stays)', async () => {
    const early = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await addPost(200, 'Power out at Beta', reading('OUTAGE', 'INVESTIGATING', ['Beta']));
    await processPending();
    await reprocessPost(early);
    const all = await outages();
    expect(all).toHaveLength(2);
    expect(all.every((o) => o.posts.length === 1)).toBe(true);
  });
});

describe('E03: a re-read that is not accepted leaves the published outage alone', () => {
  it('the outage, its timeline and the post status stay as they were', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    const before = await outages();
    expect(before).toHaveLength(1);
    readings.set(id, { ...reading('OUTAGE', 'INVESTIGATING', ['Alpha']), status: 'NEEDS_REVIEW', keptAfterFailure: true, rejectedReason: 'low confidence (0.2)' });
    const r = await reprocessPost(id, { reextract: true });
    expect(r).toMatchObject({ outcome: 'KEPT_EXISTING', reprocessed: false });
    const after = await outages();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect((await prisma.sourcePost.findUnique({ where: { id } })).processingStatus).toBe('RELEVANT');
    expect(await prisma.linkDecision.count({ where: { postId: id } })).toBe(1);
  });
  it('an accepted re-read still replaces the old one', async () => {
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    readings.set(id, reading('OUTAGE', 'INVESTIGATING', ['Beta']));
    await reprocessPost(id, { reextract: true });
    const all = await outages();
    expect(all).toHaveLength(1);
    expect((await prisma.outageNode.findMany({ where: { outageId: all[0].id }, include: { node: true } })).map((n) => n.node.name)).toEqual(['Beta']);
  });
});

describe('E10: an effect records the reading it was built from', () => {
  it('and the stored revision changes when a re-read changes something that is not the fault count', async () => {
    const { readingRevision } = await import('../../src/lib/reading-revision.js');
    const id = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    const first = (await prisma.outagePost.findFirst({ where: { postId: id } })).effect.reading;
    expect(first).toBe(readingRevision(readings.get(id).result));
    readings.set(id, reading('OUTAGE', 'REPAIRING', ['Alpha'])); // same fault count, same class, different status
    await reprocessPost(id, { reextract: true });
    const second = (await prisma.outagePost.findFirst({ where: { postId: id } })).effect.reading;
    expect(second).toBe(readingRevision(readings.get(id).result));
    expect(second).not.toBe(first);
  });
});

describe('B3: a temporary tie-break failure is retried by itself, real ambiguity waits for a person', () => {
  // (a different place each time: an answer already cached from an earlier test would otherwise mean no question is asked)
  const setup = async (place) => {
    await addPost(0, place + ' feeder fault', reading('OUTAGE', 'INVESTIGATING', [place + ' Feeder'], { localities: [{ name: place + ' Heights', state: 'AFFECTED' }] }));
    return addPost(150, place + ' Heights substation fault', reading('OUTAGE', 'INVESTIGATING', [place + ' Heights'])); // a tie-break is needed
  };
  const later = (min) => new Date(Date.now() + min * 60_000);

  it('a busy provider: retried in the call, then queued, then linked by a later retry, and the queue entry is cleared', async () => {
    const { retryTieBreaks } = await import('../../src/modules/processing/processor.service.js');
    tieBreaks.fail = '503 Service Unavailable';
    const b = await setup('Marlow');
    await processPending();
    expect(tieBreaks.calls).toBeGreaterThanOrEqual(3); // tried 3 times in the one call
    expect((await prisma.linkDecision.findFirst({ where: { postId: b } })).outcome).toBe('NEEDS_REVIEW');
    expect((await prisma.sourcePost.findUnique({ where: { id: b } })).processingStatus).toBe('NEEDS_REVIEW');
    const queued = await prisma.retryAttempt.findFirst({ where: { postId: b } });
    expect(queued).toMatchObject({ kind: 'TIEBREAK', attempts: 0 }); // no automatic retry made yet
    expect(queued.lastError).toMatch(/503/);

    expect(await retryTieBreaks({ now: new Date() })).toEqual({ tried: 0, fixed: 0, gaveUp: 0 }); // not due yet

    tieBreaks.fail = null; // the provider is back
    expect(await retryTieBreaks({ now: later(6) })).toEqual({ tried: 1, fixed: 1, gaveUp: 0 });
    expect((await prisma.linkDecision.findFirst({ where: { postId: b } })).outcome).toBe('LINKED');
    expect((await prisma.sourcePost.findUnique({ where: { id: b } })).processingStatus).toBe('RELEVANT');
    expect(await prisma.retryAttempt.count()).toBe(0);
    expect(await outages()).toHaveLength(1);
  });

  it('keeps failing: five retries at 5, 15, 45, 120 and 360 minutes, then it is left for a person and never retried again', async () => {
    const { retryTieBreaks } = await import('../../src/modules/processing/processor.service.js');
    tieBreaks.fail = '503 Service Unavailable';
    const b = await setup('Norwick');
    await processPending();
    const row = () => prisma.retryAttempt.findFirst({ where: { postId: b } });
    const gaps = [5, 15, 45, 120, 360];
    let due = (await row()).nextRetryAt;
    const failedAt = due;
    expect(Math.round((+due - Date.now()) / 60_000)).toBe(5); // first retry: 5 minutes after the failure
    for (let i = 0; i < 5; i++) {
      expect(await retryTieBreaks({ now: new Date(+due - 1000) })).toEqual({ tried: 0, fixed: 0, gaveUp: 0 }); // one second early: not due
      const r = await retryTieBreaks({ now: due });
      expect(r).toMatchObject({ tried: 1, fixed: 0 });
      const now = await row();
      expect(now.attempts).toBe(i + 1);
      if (i < 4) {
        expect((+now.nextRetryAt - +due) / 60_000).toBe(gaps[i + 1]); // the wait after retry i+1
        due = now.nextRetryAt;
      } else {
        expect(r.gaveUp).toBe(1);
        expect(now.nextRetryAt.getUTCFullYear()).toBe(9999); // gave up: nothing is ever due again
      }
    }
    expect(+failedAt).toBeGreaterThan(0);
    expect(await retryTieBreaks({ now: new Date(+due + 10_000_000_000) })).toEqual({ tried: 0, fixed: 0, gaveUp: 0 });
    expect((await prisma.linkDecision.findFirst({ where: { postId: b } })).outcome).toBe('NEEDS_REVIEW'); // still waiting for a person
  });

  it('a failure that will not change (a call limit) is not queued for retry: it waits for a person straight away', async () => {
    tieBreaks.fail = 'AI call limit reached for this run';
    const b = await setup('Ostrava');
    await processPending();
    expect((await prisma.linkDecision.findFirst({ where: { postId: b } })).outcome).toBe('NEEDS_REVIEW');
    expect(tieBreaks.calls).toBe(1); // not retried in the call either
    expect(await prisma.retryAttempt.count()).toBe(0);
  });
});

describe('B6: a repair can be undone', () => {
  const state = async () => ({
    outages: (await outages()).map((o) => ({ posts: o.posts.map((p) => `${p.postId}:${p.faultIndex}:${p.role}`).sort(), status: o.status })).sort((a, b) => a.posts[0].localeCompare(b.posts[0])),
    decisions: (await prisma.linkDecision.findMany({ orderBy: [{ postId: 'asc' }, { faultIndex: 'asc' }] })).map((d) => `${d.postId}:${d.faultIndex}:${d.outcome}:${d.outageId ? 'o' : '-'}`),
    nodes: (await prisma.infraNode.findMany({ orderBy: { normalizedKey: 'asc' } })).map((n) => `${n.normalizedKey}:${n.evidenceCount}:${n.lifecycle}`),
    evidence: await prisma.evidenceContribution.count(),
    overrides: await prisma.linkOverride.count(),
  });
  const load = async () => {
    const m = await import('../../src/modules/processing/repair.js');
    return m;
  };

  it('a re-link that moves a post is put back exactly: entries, decisions, graph counters, outage state', async () => {
    const { snapshotForPosts, restoreSnapshot } = await load();
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(30, 'Alpha crew on site', reading('UPDATE', 'CREW_ON_SITE', ['Alpha']));
    await processPending();
    const before = await state();
    const snap = await snapshotForPosts(prisma, [b]);

    readings.set(b, reading('OUTAGE', 'INVESTIGATING', ['Zulu'])); // the repair: a re-read moves it to different equipment
    await reprocessPost(b, { reextract: true });
    const moved = await state();
    expect(moved).not.toEqual(before);

    const r = await restoreSnapshot({ prisma, snapshot: snap });
    expect(r).toMatchObject({ posts: 1 });
    expect(await state()).toEqual(before);
    expect(await prisma.infraNode.count({ where: { normalizedKey: 'zulu' } })).toBe(0); // equipment the repair introduced is gone too
    expect(a).toBeTruthy();
  });

  it('an outage the repair deleted comes back with its id, and a correction that was added is removed', async () => {
    const { snapshotForPosts, restoreSnapshot } = await load();
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const c = await addPost(20, 'Power out at Zulu', reading('OUTAGE', 'INVESTIGATING', ['Zulu']));
    await processPending();
    const before = await outages();
    const zuluOutage = before.find((o) => o.posts.some((p) => p.postId === c));
    const snap = await snapshotForPosts(prisma, [c]);

    await setOverride({ postId: c, action: 'JOIN', anchorPostId: a }); // the repair: join Zulu into Alpha's outage (Zulu's own outage disappears)
    await reprocessPost(c);
    expect(await outages()).toHaveLength(1);
    expect(await prisma.linkOverride.count()).toBe(1);

    await restoreSnapshot({ prisma, snapshot: snap });
    const after = await outages();
    expect(after).toHaveLength(2);
    expect(after.some((o) => o.id === zuluOutage.id)).toBe(true); // the same outage, same id
    expect(await prisma.linkOverride.count()).toBe(0);
  });

  it('a worker that lost the lease restores nothing', async () => {
    const { snapshotForPosts, restoreSnapshot } = await load();
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    await processPending();
    const snap = await snapshotForPosts(prisma, [a]);
    await reprocessPost(a);
    const before = await state();
    const ghost = { name: 'pipeline', owner: 'expired-owner', lost: false, assertHeld() {} };
    await expect(restoreSnapshot({ prisma, snapshot: snap, ctx: ghost })).rejects.toThrow(/lease/i);
    expect(await state()).toEqual(before);
  });

  it('undo keeps what a newer post taught the graph (counters are corrected by difference, not overwritten)', async () => {
    const { snapshotForPosts, restoreSnapshot } = await load();
    await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(10, 'Alpha crew', reading('UPDATE', 'CREW_ON_SITE', ['Alpha']));
    await processPending();
    const snap = await snapshotForPosts(prisma, [b]);
    await reprocessPost(b);
    await addPost(20, 'Alpha more news', reading('UPDATE', 'CREW_ON_SITE', ['Alpha'])); // arrives after the snapshot
    await processPending();
    const node = () => prisma.infraNode.findFirst({ where: { normalizedKey: 'alpha' } });
    expect((await node()).evidenceCount).toBe(3);
    await restoreSnapshot({ prisma, snapshot: snap });
    const n = await node();
    expect(n.evidenceCount).toBe(3);
    expect(await prisma.evidenceContribution.count({ where: { kind: 'NODE', refA: n.id } })).toBe(3);
  });

  it('undoing twice changes nothing the second time', async () => {
    const { snapshotForPosts, restoreSnapshot } = await load();
    await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const b = await addPost(10, 'Alpha crew', reading('UPDATE', 'CREW_ON_SITE', ['Alpha']));
    await processPending();
    const snap = await snapshotForPosts(prisma, [b]);
    await reprocessPost(b);
    await restoreSnapshot({ prisma, snapshot: snap });
    const once = await state();
    const second = await restoreSnapshot({ prisma, snapshot: snap });
    expect(second.alreadyRestored).toBe(true);
    expect(await state()).toEqual(once);
  });

  it('describes what a repair changed, post by post', async () => {
    const { snapshotForPosts, describeChange } = await load();
    const a = await addPost(0, 'Power out at Alpha', reading('OUTAGE', 'INVESTIGATING', ['Alpha']));
    const c = await addPost(20, 'Power out at Zulu', reading('OUTAGE', 'INVESTIGATING', ['Zulu']));
    await processPending();
    const snap = await snapshotForPosts(prisma, [c]);
    expect((await describeChange(prisma, snap))[0].changed).toBe(false);
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    await setOverride({ postId: c, action: 'JOIN', anchorPostId: a });
    await reprocessPost(c);
    const [row] = await describeChange(prisma, snap);
    expect(row.changed).toBe(true);
    expect(row.was[0].label).toMatch(/Zulu/i);
  });
});
