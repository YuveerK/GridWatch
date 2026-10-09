import { beforeEach,afterAll,beforeAll,describe,it,expect,vi } from 'vitest';
process.env.OPERATOR_TOKEN = 'guided-review-operator-test-token';
process.env.REVIEW_CORRECTIONS_ENABLED = 'on';
process.env.VERIFIER_ENABLED = 'off';
process.env.ALLOW_LOCAL_OPERATOR = 'off';
vi.mock('../../src/modules/ai/gemini.client.js',() => ({ generateJson: async () => { throw new Error('Provider must not be contacted by stored review actions'); } }));
const { prisma,resetDb } = await import('./db.js');
const { env } = await import('../../src/config/env.js');
const { readerFor } = await import('../../src/modules/ai/reader-registry.js');
const { processPost,reprocessPost,processPending,resetLearnedState,retryHumanAnchors,resetMunicipalityCache } = await import('../../src/modules/processing/processor.service.js');
const { resetLocalityIndex } = await import('../../src/modules/infrastructure/infrastructure.service.js');
const { saveReviewItems,resolveReviewItem } = await import('../../src/modules/review/review.service.js');
const { collectCases,reviewSummary,ListInput,listCases } = { ...await import('../../src/modules/review/cases.js'),...await import('../../src/modules/review/contracts.js') };
const { planCorrection,publicPreview } = await import('../../src/modules/review/planner.js');
const { applyCorrection,undoAction,affectedState } = await import('../../src/modules/review/actions.js');
const { inspectCase } = await import('../../src/modules/review/inspection.js');
const { acquireLease,releaseLease,PIPELINE } = await import('../../src/modules/coordination/lease.js');
const { createApp } = await import('../../src/app.js');
const { fingerprint,json } = await import('../../src/modules/review/contracts.js');
const T = new Date(Date.now()-3*3600000);
let n = 0;
let server,base;
beforeAll(async () => { server = createApp().listen(0,'127.0.0.1');await new Promise((r) => server.once('listening',r));base = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(async () => {
  await resetDb();n = 0;resetLocalityIndex();resetMunicipalityCache();
  await prisma.sourceAccount.createMany({ data: [{ id: 'electric',platform: 'X',externalId: '100',displayName: 'CityPowerJhb',serviceType: 'ELECTRICITY',updatedAt: T },{ id: 'water',platform: 'X',externalId: '200',displayName: 'JHBWater',serviceType: 'WATER',updatedAt: T }] });
  await prisma.locality.createMany({ data: ['Alpha','Beta'].map((name) => ({ id: name.toLowerCase(),canonicalName: name,normalizedName: name.toLowerCase(),updatedAt: T })) });
});
const reading = (over = {}) => ({ relevance: 'OUTAGE',status: 'INVESTIGATING',sdc: null,cause: null,eta_text: null,restoration_percent: null,entities: [{ type: 'SUBSTATION',name: 'Alpha Station',parent_name: null }],localities: [{ name: 'Alpha',state: 'AFFECTED' }],faults: [],update_summary: 'The utility reports an interruption affecting Alpha.',image_text: null,confidence: .95,review_reason: null,...over });
async function post({ service = 'ELECTRICITY',text = 'Power interrupted at Alpha Station affecting Alpha.',h = 0,result,process = true } = {}) {
  const id = `guided-${++n}`;
  await prisma.sourcePost.create({ data: { id,externalId: String(990000+n),sourceAccount: service === 'WATER' ? 'JHBWater' : 'CityPowerJhb',serviceType: service,text,publishedAt: new Date(T.getTime()+h*3600000),updatedAt: T } });
  await prisma.postExtraction.create({ data: { postId: id,promptVersion: readerFor(service).promptVersion ?? env.AI_PROMPT_VERSION,model: 'stored',status: 'SUCCEEDED',relevance: (result ?? reading()).relevance,result: result ?? reading() } });
  if (process) { const p = await processPost(id);expect(['NEW','LINKED']).toContain(p.outcome); }
  return id;
}
async function flag(postId,code = 'CHANGED_SCOPE',faultIndex = 0) {
  await saveReviewItems({ prisma,suspicions: [{ postId,faultIndex,reasons: [{ code,detail: 'Check the source evidence.' }] }] });
  return (await collectCases(prisma)).cases.find((c) => c.postId === postId && c.faultIndex === faultIndex);
}
const inputFor = (type,text,extra = {}) => ({ correction: { type,...extra },note: 'The original utility evidence establishes this correction.',evidence: { kind: 'TEXT',quote: text } });
async function apply(c,input,opts) { const p = await planCorrection(c.id,input,prisma);return applyCorrection(c.id,{ ...input,fingerprint: p.fingerprint,requestId: `request-${++n}-guided` },'token',opts); }
const assigned = async (postId,index = 0) => prisma.outagePost.findFirst({ where: { postId,faultIndex: index } });

describe('guided human repairs',() => {
  it('moves a misplaced restoration, removes its empty duplicate, and safely undoes it',async () => {
    const anchor = await post();const first = await assigned(anchor);
    const p = await post({ text: 'Power supply restored to Alpha.',h: 1,result: reading({ relevance: 'RESTORATION',status: 'RESTORED',entities: [],localities: [{ name: 'Beta',state: 'RESTORED' }] }) });
    const old = await assigned(p);expect(old.outageId).not.toBe(first.outageId);
    const c = await flag(p,'RESTORATION_SPLIT_FROM_INCIDENT');
    const input = inputFor('JOIN','Power supply restored',{ targetOutageId: first.outageId });
    const preview = await planCorrection(c.id,input,prisma);
    expect(preview.after.find((o) => o.id === old.outageId).deleted).toBe(true);
    const action = await apply(c,input);expect(action.state,JSON.stringify(action.result)).toBe('APPLIED');
    expect((await assigned(p)).outageId).toBe(first.outageId);expect((await prisma.outage.findUnique({ where: { id: first.outageId } })).status).toBe('RESTORED');
    const undo = await undoAction(c.id,action.id);
    expect((await undoAction(c.id,action.id,{ apply: true,fingerprint: undo.fingerprint })).state).toBe('ROLLED_BACK');
    expect((await assigned(p)).outageId).toBe(old.outageId);expect((await prisma.outage.findUnique({ where: { id: first.outageId } })).status).toBe('ACTIVE');
  });
  it('stores a split that survives reprocessing and emits no notifications',async () => {
    const a = await post();const p = await post({ h: 1 });const original = await assigned(a);
    const c = await flag(p);const action = await apply(c,inputFor('SPLIT','Power interrupted'));expect(action.state,JSON.stringify(action.result)).toBe('APPLIED');
    expect((await assigned(p)).outageId).not.toBe(original.outageId);
    await reprocessPost(p);expect((await assigned(p)).outageId).not.toBe((await assigned(a)).outageId);
    expect(await prisma.notificationEvent.count()).toBe(0);
  });
  it('rejects an outdated preview and busy pipeline without storing any correction',async () => {
    const p = await post();const c = await flag(p);const input = inputFor('SPLIT','Power interrupted');const preview = await planCorrection(c.id,input,prisma);
    await prisma.sourcePost.update({ where: { id: p },data: { text: 'Power interrupted. Updated source wording.' } });
    await expect(applyCorrection(c.id,{ ...input,fingerprint: preview.fingerprint,requestId: 'stale-request-guided' },'token')).rejects.toMatchObject({ code: 'stale_preview' });
    expect(await prisma.reviewAction.count()).toBe(0);expect(await prisma.linkOverride.count()).toBe(0);
    await acquireLease(PIPELINE,'busy-review-test',60000);
    try { await expect(applyCorrection(c.id,{ ...input,fingerprint: preview.fingerprint,requestId: 'busy-request-guided' },'token')).rejects.toMatchObject({ code: 'pipeline_busy' }); }
    finally { await releaseLease(PIPELINE,'busy-review-test'); }
    expect(await prisma.reviewAction.count()).toBe(0);
  });
  it('returns the original result for a duplicate submitted request',async () => {
    const p = await post();const c = await flag(p);const input = inputFor('SPLIT','Power interrupted');const preview = await planCorrection(c.id,input,prisma);
    const raw = { ...input,fingerprint: preview.fingerprint,requestId: 'duplicate-request-guided' };
    const a = await applyCorrection(c.id,raw,'token');const b = await applyCorrection(c.id,raw,'token');expect(a.id).toBe(b.id);expect(await prisma.reviewAction.count()).toBe(1);
  });
  it('preserves an untouched sibling while correcting one graphic section',async () => {
    const result = reading({ relevance: 'SDC_SUMMARY',faults: [{ status: 'INVESTIGATING',equipment: [{ type: 'SUBSTATION',name: 'Alpha Station',parent_name: null }],localities: [{ name: 'Alpha',state: 'AFFECTED' }],summary: 'Alpha interruption.' },{ status: 'INVESTIGATING',equipment: [{ type: 'SUBSTATION',name: 'Beta Station',parent_name: null }],localities: [{ name: 'Beta',state: 'AFFECTED' }],summary: 'Beta interruption.' }] });
    const p = await post({ result });const sibling = await assigned(p,1);const siblingDecision = await prisma.linkDecision.findUnique({ where: { postId_faultIndex: { postId: p,faultIndex: 1 } } });
    const c = await flag(p,'CHANGED_SCOPE',0);const action = await apply(c,inputFor('SPLIT','Power interrupted'));expect(action.state,JSON.stringify(action.result)).toBe('APPLIED');
    expect(await assigned(p,1)).toEqual(sibling);expect(await prisma.linkDecision.findUnique({ where: { postId_faultIndex: { postId: p,faultIndex: 1 } } })).toEqual(siblingDecision);
  });
  it('lets multiple graphic faults contribute to one incident, and retains their human links on replay',async () => {
    const anchor = await post();const target = await assigned(anchor);
    const result = reading({ relevance: 'SDC_SUMMARY',faults: [0,1].map((i) => ({ status: 'REPAIRING',equipment: [{ type: 'SUBSTATION',name: i ? 'Beta Station' : 'Alpha Station',parent_name: null }],localities: [{ name: i ? 'Beta' : 'Alpha',state: 'AFFECTED' }],summary: 'Utility reports ongoing repairs.' })) });
    const p = await post({ result,h: 1 });const c = await flag(p,'CHANGED_SCOPE',1);
    const action = await apply(c,inputFor('JOIN','Power interrupted',{ targetOutageId: target.outageId }));expect(action.state,JSON.stringify(action.result)).toBe('APPLIED');
    expect(await prisma.outagePost.count({ where: { postId: p,outageId: target.outageId } })).toBe(2);
    await reprocessPost(p);expect(await prisma.outagePost.count({ where: { postId: p,outageId: (await assigned(anchor)).outageId } })).toBe(2);
  });
  it('classifies a post as informational durably and can restore the prior interpretation',async () => {
    const p = await post();const c = await flag(p);const detail = await inspectCase(c.id);
    const reading = { ...detail.readingDraft,faults: detail.readingDraft.faults.map((f) => ({ ...f,relevance: 'GENERAL_NOTICE' })) };
    const action = await apply(c,inputFor('READING','Power interrupted',{ reading,placements: [] }));expect(action.state,JSON.stringify(action.result)).toBe('APPLIED');
    expect(await assigned(p)).toBeNull();expect((await prisma.sourcePost.findUnique({ where: { id: p } })).processingStatus).toBe('GENERAL_NOTICE');
    await reprocessPost(p);expect(await assigned(p)).toBeNull();
    // Reprocessing intentionally changes the journal guard; direct undo must refuse that newer work.
    await expect(undoAction(c.id,action.id)).rejects.toMatchObject({ code: 'undo_conflict' });
    expect((await inspectCase(c.id)).tab).toBe('engineering');expect(await prisma.reviewAction.count({ where: { type: 'UNDO_BLOCKED' } })).toBe(1);
  });
  it('adds a source section with a new identity and preserves that layout on reprocess',async () => {
    const p = await post();const c = await flag(p);const d = await inspectCase(c.id);const old = await assigned(p);
    const extra = { ...d.readingDraft.faults[0],faultIndex: 7,entities: [{ type: 'SUBSTATION',name: 'Beta Station',parent_name: null }],localities: [{ name: 'Beta',state: 'AFFECTED' }],summary: 'Beta has a separate interruption.' };
    const reading = { ...d.readingDraft,faults: [...d.readingDraft.faults,extra] };
    const action = await apply(c,inputFor('READING','Power interrupted',{ reading,placements: [{ faultIndex: 0,targetOutageId: old.outageId },{ faultIndex: 7,targetOutageId: null }] }));expect(action.state,JSON.stringify(action.result)).toBe('APPLIED');
    expect((await assigned(p,7)).outageId).not.toBe((await assigned(p)).outageId);await reprocessPost(p);expect(await assigned(p,7)).not.toBeNull();
    expect((await prisma.linkDecision.findMany({ where: { postId: p },orderBy: { faultIndex: 'asc' } })).map((d) => d.faultIndex)).toEqual([0,7]);
  });
  it('reopens and blocks a human reading when the source graphic changes',async () => {
    const p = await post();
    await prisma.postMedia.create({ data: { id: 'review-image',postId: p,mediaKey: 'utility-a',mediaType: 'photo',url: 'https://pbs.twimg.com/media/a.jpg?name=large',width: 200,height: 400 } });
    const c = await flag(p);const d = await inspectCase(c.id);const old = await assigned(p);
    const corrected = { ...d.readingDraft,faults: d.readingDraft.faults.map((f) => ({ ...f,cause: 'Equipment fault described by the utility' })) };
    const a = await apply(c,inputFor('READING','Power interrupted',{ reading: corrected,placements: [{ faultIndex: 0,targetOutageId: old.outageId }] }));
    expect(a.state,JSON.stringify(a.result)).toBe('APPLIED');
    await prisma.postMedia.update({ where: { id: 'review-image' },data: { mediaKey: 'replacement',url: 'https://pbs.twimg.com/media/replacement.jpg' } });
    expect((await collectCases(prisma)).cases.some((c) => c.postId === p && c.reasons.some((r) => r.code === 'READING_CONFLICT'))).toBe(true);
    await reprocessPost(p);
    expect((await prisma.sourcePost.findUnique({ where: { id: p } })).processingStatus).toBe('NEEDS_REVIEW');
    expect(await prisma.readingOverride.count({ where: { postId: p } })).toBe(1);
    expect((await collectCases(prisma)).cases.some((c) => c.postId === p && c.blocked)).toBe(true);
  });
  it('keeps Water isolated and cannot turn pumping recovery into customer restoration',async () => {
    const a = await post();const target = await assigned(a);
    const p = await post({ service: 'WATER',text: 'Pumping resumed at Alpha Reservoir. System is recovering.',result: reading({ relevance: 'UPDATE',status: 'INVESTIGATING',entities: [{ type: 'RESERVOIR',name: 'Alpha Reservoir',parent_name: null }],water_state: 'RECOVERING',customer_supply: null }) });
    const c = await flag(p);
    await expect(planCorrection(c.id,inputFor('JOIN','Pumping resumed',{ targetOutageId: target.outageId }),prisma)).rejects.toMatchObject({ code: 'incompatible_target' });
    const d = await inspectCase(c.id);const corrected = { ...d.readingDraft,faults: d.readingDraft.faults.map((f) => ({ ...f,water_state: 'NORMAL',customer_supply: 'RESTORED' })) };
    await expect(planCorrection(c.id,inputFor('READING','Pumping resumed',{ reading: corrected,placements: [] }),prisma)).rejects.toMatchObject({ code: 'customer_evidence_required' });
  });
  it('stages a reread without changing accepted readings or incidents',async () => {
    const p = await post();const c = await flag(p);const before = await affectedState(prisma,{ postIds: [p],outageIds: [(await assigned(p)).outageId] });
    const input = inputFor('REREAD','Power interrupted');const action = await apply(c,input,{ reread: async () => ({ status: 'SUCCEEDED',result: reading({ status: 'REPAIRING' }),relevance: 'OUTAGE',draft: true }) });
    expect(action.state).toBe('PROPOSED');expect(action.result.reading.faults[0].status).toBe('REPAIRING');
    expect(await affectedState(prisma,{ postIds: [p],outageIds: [(await assigned(p)).outageId] })).toEqual(before);
  });
  it('rolls back the whole operation when postconditions fail',async () => {
    const p = await post();const c = await flag(p);const before = await assigned(p);
    const spy = vi.spyOn(prisma,'$transaction');const original = prisma.$transaction.bind(prisma);
    spy.mockImplementationOnce((fn,opts) => original(async (tx) => { await fn(tx);throw new Error('injected postcondition failure'); },opts));
    const action = await apply(c,inputFor('SPLIT','Power interrupted'));spy.mockRestore();
    expect(action.state).toBe('FAILED');expect(await assigned(p)).toEqual(before);expect(await prisma.linkOverride.count()).toBe(0);
  });
  it('holds a human join with a missing anchor instead of choosing another outage',async () => {
    const anchor = await post({ process: false });const p = await post({ process: false });
    await prisma.linkOverride.create({ data: { postId: p,faultIndex: 0,action: 'JOIN',anchorPostId: anchor } });
    expect((await processPost(p)).outcome).toBe('NEEDS_REVIEW');expect(await assigned(p)).toBeNull();
  });
});

describe('review coverage and protected interfaces',() => {
  it('exposes missing dispositions even without a legacy review flag',async () => {
    const p = await post({ process: false });await prisma.sourcePost.update({ where: { id: p },data: { processingStatus: 'RELEVANT' } });
    const cases = (await collectCases(prisma)).cases.filter((c) => c.postId === p);expect(cases[0].category).toBe('MISSING_DISPOSITION');
  });
  it('an empty decision queue cannot conceal unhealthy source freshness',async () => {
    const summary = await reviewSummary(prisma);expect(summary.accounts.some((a) => a.problems.length)).toBe(true);expect(summary.counts.decision).toBeGreaterThan(0);
  });
  it('lists both services by default with exact counts and filtered pagination',async () => {
    const e = await post();await flag(e);
    const w = await post({ service: 'WATER',text: 'Water interrupted at Alpha Reservoir.',result: reading({ entities: [{ type: 'RESERVOIR',name: 'Alpha Reservoir',parent_name: null }],water_state: 'NO_SUPPLY' }) });await flag(w);
    const all = await listCases(ListInput.parse({ source: 'JHBWater',limit: 1 }),prisma);expect(all.total).toBeGreaterThanOrEqual(1);expect(all.data.every((c) => c.serviceType === 'WATER')).toBe(true);
  });
  it('rejects unauthenticated reads and writes, and legacy dismissal of blocked work',async () => {
    expect((await fetch(`${base}/admin/review-cases/summary`)).status).toBe(401);
    const p = await post({ process: false });await prisma.sourcePost.update({ where: { id: p },data: { processingStatus: 'NEEDS_REVIEW' } });await prisma.linkDecision.create({ data: { postId: p,outcome: 'NEEDS_REVIEW',faultIndex: 0 } });const c = await flag(p);
    expect((await fetch(`${base}/admin/review-cases/${c.id}/actions`,{ method: 'POST',headers: { 'content-type': 'application/json' },body: '{}' })).status).toBe(401);
    const item = await prisma.reviewItem.findFirst({ where: { postId: p } });await expect(resolveReviewItem({ prisma,id: item.id })).rejects.toMatchObject({ code: 'still_blocked' });
  });
  it('reading a case or preview performs no writes or provider calls',async () => {
    const p = await post();const c = await flag(p);const before = await affectedState(prisma,{ postIds: [p],outageIds: [(await assigned(p)).outageId] });
    await inspectCase(c.id);await planCorrection(c.id,inputFor('SPLIT','Power interrupted'),prisma);
    expect(await prisma.reviewAction.count()).toBe(0);expect(await prisma.reviewCase.count()).toBe(0);expect(await affectedState(prisma,{ postIds: [p],outageIds: [(await assigned(p)).outageId] })).toEqual(before);
  });
  it('persists an engineering handoff without closing blocked work',async () => {
    const p = await post({ process: false });await prisma.sourcePost.update({ where: { id: p },data: { processingStatus: 'NEEDS_REVIEW' } });const c = await flag(p);
    const action = await apply(c,inputFor('ENGINEERING','Power interrupted'));expect(action.state).toBe('APPLIED');
    const d = await inspectCase(c.id);expect(d.tab).toBe('engineering');expect(d.blocked).toBe(true);expect(d.brief).toContain('Fix the general mechanism');
  });
});


describe('rebuild, coverage, recovery and rollout acceptance',() => {
  it('completes a deferred human join after its newer anchor appears without disturbing siblings',async () => {
    const older = await post({ process: false });const later = await post({ h: 1,process: false });
    await prisma.linkOverride.create({ data: { postId: older,faultIndex: 0,action: 'JOIN',anchorPostId: later,anchorFaultIndex: 0 } });
    expect((await processPost(older)).outcome).toBe('NEEDS_REVIEW');await processPost(later);
    expect((await retryHumanAnchors()).fixed).toBe(1);expect((await assigned(older)).outageId).toBe((await assigned(later)).outageId);
  });
  it('preserves reading edits, stable segmentation and joins through a chronological rebuild',async () => {
    const p = await post();const c = await flag(p);const d = await inspectCase(c.id);
    const corrected = { ...d.readingDraft,faults: [{ ...d.readingDraft.faults[0],status: 'REPAIRING' }] };
    expect((await apply(c,inputFor('READING','Power interrupted',{ reading: corrected,placements: [{ faultIndex: 0,targetOutageId: (await assigned(p)).outageId }] }))).state).toBe('APPLIED');
    const later = await post({ h: 1 });const lc = await flag(later);expect((await apply(lc,inputFor('JOIN','Power interrupted',{ targetOutageId: (await assigned(p)).outageId }))).state).toBe('APPLIED');
    await resetLearnedState();resetLocalityIndex();await processPending({ ignoreIncomplete: true });
    expect((await assigned(later)).outageId).toBe((await assigned(p)).outageId);expect((await assigned(p)).effect.status).toBe('REPAIRING');expect(await prisma.readingOverride.count()).toBe(1);
  });
  it('rejects cyclic join dependencies instead of applying a different association',async () => {
    const p = await post({ process: false });const a = await post({ process: false });
    await prisma.linkOverride.createMany({ data: [{ postId: p,faultIndex: 0,action: 'JOIN',anchorPostId: a },{ postId: a,faultIndex: 0,action: 'JOIN',anchorPostId: p }] });
    expect((await processPost(p)).outcome).toBe('NEEDS_REVIEW');expect(await assigned(p)).toBeNull();
    const { setOverride } = await import('../../src/modules/outages/overrides.js');
    await expect(setOverride({ postId: p,action: 'JOIN',anchorPostId: a })).rejects.toThrow(/cyclic/);
  });
  it('rejects a known municipality mismatch on preview',async () => {
    const p = await post();const c = await flag(p);const a = await post({ h: 1 });
    await prisma.municipality.upsert({ where: { id: 'review-other-city' },create: { id: 'review-other-city',code: 'REVIEWOTHER',name: 'Other city' },update: {} });
    const johannesburg = await prisma.municipality.findFirst({ where: { code: 'JHB' } });
    const own = johannesburg ?? await prisma.municipality.create({ data: { id: 'review-own-city',code: 'REVIEWOWN',name: 'Own city' } });
    await prisma.sourceAccount.update({ where: { id: 'electric' },data: { municipalityId: own.id } });
    await prisma.outage.update({ where: { id: (await assigned(a)).outageId },data: { municipalityId: 'review-other-city' } });
    await expect(planCorrection(c.id,inputFor('JOIN','Power interrupted',{ targetOutageId: (await assigned(a)).outageId }),prisma)).rejects.toMatchObject({ code: 'incompatible_target' });
  });
  it('can safely undo an informational reading before newer work arrives',async () => {
    const p = await post();const c = await flag(p);const d = await inspectCase(c.id);const old = await assigned(p);
    const action = await apply(c,inputFor('READING','Power interrupted',{ reading: { ...d.readingDraft,faults: d.readingDraft.faults.map((f) => ({ ...f,relevance: 'GENERAL_NOTICE' })) },placements: [] }));
    const preview = await undoAction(c.id,action.id);await undoAction(c.id,action.id,{ apply: true,fingerprint: preview.fingerprint });
    expect((await assigned(p)).outageId).toBe(old.outageId);expect(await prisma.readingOverride.count()).toBe(0);expect(await prisma.reviewAction.count({ where: { type: 'UNDO' } })).toBe(1);
  });
  it('keeps an interrupted journal visible and permits guarded recovery of an untouched snapshot',async () => {
    const p = await post();const c = await flag(p);const action = await apply(c,inputFor('SPLIT','Power interrupted'));
    const preview = await undoAction(c.id,action.id);await undoAction(c.id,action.id,{ apply: true,fingerprint: preview.fingerprint });
    await prisma.reviewAction.deleteMany({ where: { type: 'UNDO' } });
    const live = await affectedState(prisma,action.result.manifest);
    await prisma.reviewAction.update({ where: { id: action.id },data: { state: 'APPLYING',result: { manifest: action.result.manifest,guardHash: fingerprint(live) } } });
    expect((await inspectCase(c.id)).tab).toBe('engineering');
    const recovery = await undoAction(c.id,action.id);expect((await undoAction(c.id,action.id,{ apply: true,fingerprint: recovery.fingerprint })).state).toBe('ROLLED_BACK');
  });
  it('keeps engineering work until explicitly rechecked even after the concern disappears',async () => {
    const p = await post();const c = await flag(p);await apply(c,inputFor('ENGINEERING','Power interrupted'));
    await prisma.reviewItem.updateMany({ where: { postId: p },data: { status: 'RESOLVED' } });
    expect((await inspectCase(c.id)).tab).toBe('engineering');await apply(c,inputFor('RECHECK','Power interrupted'));expect((await inspectCase(c.id)).tab).toBe('history');
  });
  it('recognizes successful empty fetches and recorded processing coverage for both sources',async () => {
    const now = new Date();
    await prisma.ingestionState.createMany({ data: [{ accountId: '100',lastCompletedAt: now },{ accountId: '200',lastCompletedAt: now }] });
    await prisma.ingestionRun.createMany({ data: ['electric','water'].map((sourceAccountId) => ({ id: `empty-${sourceAccountId}`,sourceAccountId,status: 'SUCCEEDED',startedAt: now,completedAt: now,postsInserted: 0 })) });
    await prisma.cycleQuality.create({ data: { trigger: 'test',status: 'COMPLETE',startedAt: now,finishedAt: now,summary: { sourceChecks: ['CityPowerJhb','JHBWater'].map((source) => ({ source,checkedAt: now.toISOString(),incomplete: false })) },posts: [],problems: [],changedOutageIds: [] } });
    const summary = await reviewSummary(prisma);expect(summary.accounts.every((a) => !a.problems.length && a.latestPostsInserted === 0 && a.lastCheck)).toBe(true);expect(summary.counts.decision).toBe(0);
  });
  it('compares unified coverage with the same stored diagnostic window',async () => {
    const p = await post({ process: false });await prisma.sourcePost.update({ where: { id: p },data: { processingStatus: 'NEEDS_REVIEW' } });await flag(p);
    const { compareReviewCoverage } = await import('../../src/modules/review/coverage.js');
    expect((await compareReviewCoverage(prisma,{ from: T,to: new Date(T.getTime()+3600000) })).passed).toBe(true);
  });
  it('backfills unindexed diagnostic findings without repairing incidents and preserves verified legacy decisions',async () => {
    const a = await post({ h: -1 });
    const p = await post({ h: 1,text: 'Power supply restored to Alpha.',result: reading({ relevance: 'RESTORATION',status: 'RESTORED',entities: [{ type: 'SUBSTATION',name: 'Beta Station',parent_name: null }],localities: [{ name: 'Alpha',state: 'RESTORED' }] }) });
    const { backfillReview } = await import('../../src/modules/review/rollout.js');
    const { compareReviewCoverage } = await import('../../src/modules/review/coverage.js');
    const before = await prisma.outagePost.findMany();
    expect((await compareReviewCoverage(prisma)).passed).toBe(false);
    const preview = await backfillReview(prisma,{ limit: 1 });expect(preview.readOnly).toBe(true);expect(await prisma.reviewItem.count()).toBe(0);
    await backfillReview(prisma,{ limit: 500,apply: true });expect((await compareReviewCoverage(prisma)).passed).toBe(true);
    expect(await prisma.outagePost.findMany()).toEqual(before);
    const item = await prisma.reviewItem.findFirst({ where: { postId: p } });expect(item).not.toBeNull();
    await prisma.reviewItem.update({ where: { id: item.id },data: { status: 'DISMISSED',resolvedAt: new Date(Date.now()+1000),resolution: 'Checked: this utility restoration refers to a separate earlier interruption.',evidenceFingerprint: null } });
    await backfillReview(prisma,{ apply: true });
    const saved = await prisma.reviewItem.findUnique({ where: { id: item.id } });expect(saved.status).toBe('DISMISSED');expect(saved.evidenceFingerprint).toBeTruthy();
    expect(await prisma.reviewAction.count({ where: { type: 'LEGACY_REVIEW' } })).toBe(1);
    expect((await compareReviewCoverage(prisma)).passed).toBe(true);
  });
  it('does not hide a legacy acknowledgement whose source was changed after review',async () => {
    await post({ h: -1 });
    const p = await post({ h: 1,text: 'Power supply restored to Alpha.',result: reading({ relevance: 'RESTORATION',status: 'RESTORED',entities: [{ type: 'SUBSTATION',name: 'Beta Station',parent_name: null }],localities: [{ name: 'Alpha',state: 'RESTORED' }] }) });
    const { backfillReview } = await import('../../src/modules/review/rollout.js');
    await backfillReview(prisma,{ apply: true });const item = await prisma.reviewItem.findFirst({ where: { postId: p } });
    await prisma.reviewItem.update({ where: { id: item.id },data: { status: 'DISMISSED',resolvedAt: new Date(Date.now()-1000),resolution: 'Previously checked.',evidenceFingerprint: null } });
    await prisma.sourcePost.update({ where: { id: p },data: { text: 'Power supply restored to Alpha. The utility revised its graphic.' } });
    await backfillReview(prisma,{ apply: true });expect((await prisma.reviewItem.findUnique({ where: { id: item.id } })).status).toBe('OPEN');
    expect((await collectCases(prisma)).cases.some((c) => c.postId === p && c.tab === 'decision')).toBe(true);
    expect(await prisma.reviewAction.count({ where: { type: 'LEGACY_REVIEW' } })).toBe(1);
  });
  it('records a real stored-evidence check without fetching or changing incident timelines',async () => {
    const p = await post();const before = await prisma.outagePost.findMany();const fetches = await prisma.ingestionRun.count();
    const { checkStoredReview } = await import('../../src/modules/review/rollout.js');
    const result = await checkStoredReview(prisma);expect(result.providerCalls).toBe(0);expect(result.incidentWrites).toBe(0);
    expect(result.summary.posts).toBe(1);expect(result.summary.outagesChanged).toBe(0);expect(result.summary.outagesChecked).toBe(1);expect(result.summary.checkMode).toBe('stored-evidence');
    expect(await prisma.outagePost.findMany()).toEqual(before);expect(await prisma.ingestionRun.count()).toBe(fetches);
    expect((await reviewSummary(prisma)).accounts.every((a) => a.lastCheck)).toBe(true);
  });
  it('includes the original utility evidence and incident timeline in a quality investigation',async () => {
    const p = await post({ text: 'Alpha customers are 50 percent restored; named Alpha streets have power.',result: reading({ status: 'PARTIALLY_RESTORED',restoration_percent: 50,localities: [{ name: 'Alpha',state: 'RESTORED' }] }) });
    // Seed the legacy aggregate inconsistency in this disposable database; inspection must expose it without repairing it.
    await prisma.outageLocality.updateMany({ where: { outageId: (await assigned(p)).outageId },data: { restored: true } });
    const { checkStoredReview } = await import('../../src/modules/review/rollout.js');await checkStoredReview(prisma);
    const c = (await collectCases(prisma)).cases.find((c) => c.outageId);expect(c).toBeTruthy();
    const d = await inspectCase(c.id);expect(d.incidents).toHaveLength(1);expect(d.evidencePosts[0].id).toBe(p);expect(d.brief).toContain('50 percent restored');expect(d.brief).toContain('complete timeline');
    const before = await prisma.outagePost.findMany();await apply(c,inputFor('ENGINEERING','Compare partial restoration with named-area evidence.'));
    expect((await inspectCase(c.id)).tab).toBe('engineering');expect(await prisma.outagePost.findMany()).toEqual(before);
  });
  it('groups resident-facing source posts while retaining both fault effects',async () => {
    const anchor = await post();const target = await assigned(anchor);
    const result = reading({ relevance: 'SDC_SUMMARY',faults: [0,1].map((i) => ({ status: 'REPAIRING',equipment: [{ type: 'SUBSTATION',name: i ? 'Beta Station' : 'Alpha Station',parent_name: null }],localities: [{ name: i ? 'Beta' : 'Alpha',state: 'AFFECTED' }],summary: 'Ongoing repair.' })) });
    const p = await post({ h: 1,result });const c = await flag(p,'CHANGED_SCOPE',1);await apply(c,inputFor('JOIN','Power interrupted',{ targetOutageId: target.outageId }));
    const body = await (await fetch(`${base}/v1/outages/${target.outageId}`)).json();expect(body.timeline).toHaveLength(2);expect(body.timeline[1].sections).toHaveLength(2);expect(body.postCount).toBe(2);
    const list = await (await fetch(`${base}/v1/outages`)).json();expect(list.data.find((o) => o.id === target.outageId)?.postCount).toBe(2);
  });
  it('guards cookie origins, expired sessions and the dedicated correction payload size',async () => {
    const { createSessionValue } = await import('../../src/modules/api/operator-auth.js');
    const cookie = `gw_operator=${createSessionValue()}`;
    expect((await fetch(`${base}/admin/review-cases/summary`,{ headers: { cookie,origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(`${base}/admin/review-cases/summary`,{ headers: { cookie: `gw_operator=${createSessionValue(Date.now()-86400000,1)}` } })).status).toBe(401);
    const p = await post();const c = await flag(p);const d = await inspectCase(c.id);
    const input = inputFor('READING','Power interrupted',{ reading: { ...d.readingDraft,faults: d.readingDraft.faults.map((f) => ({ ...f,cause: 'x'.repeat(3000),eta_text: 'x'.repeat(3000) })) },placements: [{ faultIndex: 0,targetOutageId: (await assigned(p)).outageId }] });
    const headers = { authorization: `Bearer ${env.OPERATOR_TOKEN}`,'content-type': 'application/json' };
    expect((await fetch(`${base}/admin/review-cases/${c.id}/preview`,{ method: 'POST',headers,body: JSON.stringify(input) })).status).toBe(200);
    expect((await fetch(`${base}/admin/review-cases/${c.id}/preview`,{ method: 'POST',headers,body: JSON.stringify({ padding: 'x'.repeat(140000) }) })).status).toBe(413);
  });
  it('disables mutation controls independently of read-only inspection and preview',async () => {
    const p = await post();const c = await flag(p);const input = inputFor('SPLIT','Power interrupted');const preview = await planCorrection(c.id,input,prisma);
    const original = env.REVIEW_CORRECTIONS_ENABLED;env.REVIEW_CORRECTIONS_ENABLED = 'off';
    try { await expect(applyCorrection(c.id,{ ...input,fingerprint: preview.fingerprint,requestId: 'disabled-request-guided' },'token')).rejects.toMatchObject({ code: 'corrections_disabled' });expect(await prisma.reviewAction.count()).toBe(0); }
    finally { env.REVIEW_CORRECTIONS_ENABLED = original; }
  });
});
