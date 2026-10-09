import { describe,it,expect } from 'vitest';
import { ManualReading,fingerprint,sourceMediaHash,caseId } from '../../src/modules/review/contracts.js';
import { effectiveExtraction,humanFaultItems } from '../../src/modules/review/effective-reading.js';
import { casesForPost,filterCases,postFingerprint } from '../../src/modules/review/cases.js';
import { validateEvidence,validateWaterEvidence,projectedIncident } from '../../src/modules/review/planner.js';
import { env } from '../../src/config/env.js';
import { readingRevision } from '../../src/lib/reading-revision.js';

const now = new Date('2026-10-05T10:00:00Z');
const raw = { relevance: 'OUTAGE',status: 'INVESTIGATING',entities: [],localities: [],faults: [],confidence: .9 };
const base = () => ({ id: 'p',serviceType: 'ELECTRICITY',text: 'Power supply restored to Alpha',publishedAt: now,createdAt: now,sourceAccount: 'CityPowerJhb',processingStatus: 'NEEDS_REVIEW',PostMedia: [],extractions: [{ promptVersion: env.AI_PROMPT_VERSION,status: 'SUCCEEDED',result: raw }],linkDecisions: [{ faultIndex: 0,outcome: 'NEEDS_REVIEW',reason: 'ambiguous' }],outagePosts: [],retries: [],reviewItems: [] });
const fault = (faultIndex = 0) => ({ faultIndex,relevance: 'OUTAGE',status: 'INVESTIGATING',entities: [],localities: [],summary: '',cause: null,eta_text: null,restoration_percent: null });
const override = (post,reading) => ({ schemaVersion: 1,serviceType: post.serviceType,revision: 1,payload: { sourceMediaHash: sourceMediaHash(post),sourceTextHash: fingerprint({ service: post.serviceType,text: post.text }),reading } });

describe('guided review classification and effective readings',() => {
  it('merges blocked processing and several review reasons for one fault',() => {
    const p = base();p.reviewItems = [{ faultIndex: 0,status: 'OPEN',reasons: [{ code: 'NEW_NEAR_ACTIVE' },{ code: 'UNCERTAIN_READING' }] }];
    const cases = casesForPost(p,null,now);
    expect(cases).toHaveLength(1);expect(cases[0].blocked).toBe(true);expect(cases[0].reasons).toHaveLength(3);
  });
  it('cannot hide a blocked fault by dismissing its old flag',() => {
    const p = base();p.reviewItems = [{ faultIndex: 0,status: 'DISMISSED',reasons: [{ code: 'BLOCKED' }] }];
    expect(casesForPost(p,null,now)[0].tab).toBe('decision');
  });
  it('keeps a scheduled retry out of the decision tab',() => {
    const p = base();p.retries = [{ faultIndex: 0,kind: 'TIEBREAK',attempts: 1,nextRetryAt: new Date(now.getTime()+300000) }];
    expect(casesForPost(p,null,now)[0].tab).toBe('waiting');
  });
  it('turns exhausted retries into actionable work',() => {
    const p = base();p.retries = [{ faultIndex: 0,kind: 'TIEBREAK',attempts: 5,nextRetryAt: new Date('9999-01-01') }];
    expect(casesForPost(p,null,now)[0].reasons.some((r) => r.code === 'TIEBREAK_GAVE_UP')).toBe(true);
  });
  it('an accepted current reading is unaffected by an older failed extraction',() => {
    const p = base();p.processingStatus = 'RELEVANT';p.linkDecisions = [{ faultIndex: 0,outcome: 'NEW',outageId: 'o' }];p.outagePosts = [{ faultIndex: 0,outageId: 'o' }];p.extractions.unshift({ promptVersion: 'old',status: 'FAILED' });
    expect(casesForPost(p,null,now)).toEqual([]);
  });
  it('a linked sibling cannot hide an unresolved graphic fault',() => {
    const p = base();p.extractions[0].result = { ...raw,faults: [{ status: 'INVESTIGATING',equipment: [{ name: 'A',type: 'SUBSTATION' }],localities: [] },{ status: 'INVESTIGATING',equipment: [{ name: 'B',type: 'SUBSTATION' }],localities: [] }] };
    p.linkDecisions = [{ faultIndex: 0,outcome: 'NEW',outageId: 'o' },{ faultIndex: 1,outcome: 'NEEDS_REVIEW' }];p.outagePosts = [{ faultIndex: 0,outageId: 'o' }];
    expect(casesForPost(p,null,now).find((c) => c.faultIndex === 1)?.blocked).toBe(true);
  });
  it('reopens an unchanged reason when its acknowledged evidence changed',() => {
    const p = base();p.processingStatus = 'RELEVANT';p.linkDecisions = [{ faultIndex: 0,outcome: 'NEW',outageId: 'o' }];p.outagePosts = [{ faultIndex: 0,outageId: 'o' }];
    const acknowledged = postFingerprint(p);p.reviewItems = [{ status: 'DISMISSED',faultIndex: 0,evidenceFingerprint: acknowledged,reasons: [{ code: 'CHANGED_SCOPE' }] }];
    expect(casesForPost(p,null,now)).toHaveLength(0);p.text += ' More areas affected.';expect(casesForPost(p,null,now)).toHaveLength(1);
  });
  it('gives stable links and exact filtered totals across services',() => {
    const e = casesForPost(base(),null,now)[0];const w = { ...e,id: 'w',serviceType: 'WATER' };
    expect(caseId(e.subjectKey)).toBe(e.id);expect(filterCases([e,w],{ tab: 'decision',service: 'ALL',sampled: 'false',age: 'all' },now)).toHaveLength(2);
    expect(filterCases([e,w],{ tab: 'decision',service: 'WATER',sampled: 'false',age: 'all' },now)).toEqual([w]);
  });
  it('uses a typed human reading without overwriting the machine reading',() => {
    const p = base();const r = { serviceType: 'ELECTRICITY',sdc: null,faults: [{ ...fault(4),relevance: 'RESTORATION',status: 'RESTORED' }] };p.readingOverride = override(p,r);
    const e = effectiveExtraction(p,p.extractions[0]);expect(e.human).toBe(true);expect(humanFaultItems(e)[0].faultIndex).toBe(4);expect(p.extractions[0].result.status).toBe('INVESTIGATING');
  });
  it('blocks a changed source instead of dropping its human correction',() => {
    const p = base();p.readingOverride = override(p,{ serviceType: 'ELECTRICITY',sdc: null,faults: [fault()] });p.text = 'A different notice';
    expect(effectiveExtraction(p,p.extractions[0]).humanConflict).toBe(true);
  });
  it('blocks changed image identity or layout but tolerates delivery parameters and media order',() => {
    const p = base();p.PostMedia = [{ mediaKey: 'a',mediaType: 'photo',url: 'https://pbs.twimg.com/media/a.jpg?name=large',width: 100,height: 200 },{ mediaKey: 'b',mediaType: 'photo',url: 'https://pbs.twimg.com/media/b.jpg',width: 100,height: 200 }];
    p.readingOverride = override(p,{ serviceType: 'ELECTRICITY',sdc: null,faults: [fault()] });
    p.PostMedia.reverse();p.PostMedia[1].url += '&format=jpg';
    expect(effectiveExtraction(p,p.extractions[0]).human).toBe(true);
    p.PostMedia[0].width = 300;expect(effectiveExtraction(p,p.extractions[0]).humanConflict).toBe(true);
    p.PostMedia[0].width = 100;p.PostMedia[0].mediaKey = 'replacement';expect(effectiveExtraction(p,p.extractions[0]).humanConflict).toBe(true);
    delete p.PostMedia;expect(effectiveExtraction(p,p.extractions[0]).humanConflict).toBe(true);
  });
  it('includes all human fault meanings in the effect reading fingerprint',() => {
    const p = base();p.readingOverride = override(p,{ serviceType: 'ELECTRICITY',sdc: null,faults: [fault(0),fault(7)] });
    const a = effectiveExtraction(p,p.extractions[0]);const b = structuredClone(a);b.result.__humanFaults[1].status = 'RESTORED';
    expect(readingRevision(a.result)).not.toBe(readingRevision(b.result));
  });
  it('rejects arbitrary patches, duplicate fault identities and cross-service equipment',() => {
    expect(ManualReading.safeParse({ serviceType: 'ELECTRICITY',faults: [fault(),fault()] }).success).toBe(false);
    expect(ManualReading.safeParse({ serviceType: 'ELECTRICITY',faults: [{ ...fault(),sql: 'anything' }] }).success).toBe(false);
    expect(ManualReading.safeParse({ serviceType: 'WATER',faults: [{ ...fault(),water_state: 'LOW',entities: [{ name: 'x',type: 'SUBSTATION' }] }] }).success).toBe(false);
  });
});

describe('source evidence and chronological previews',() => {
  it('requires an actual source-text quote or an attached image',() => {
    expect(() => validateEvidence(base(),{ kind: 'TEXT',quote: 'unrelated words' })).toThrow(/Quote/);
    expect(() => validateEvidence(base(),{ kind: 'IMAGE',quote: 'words from a picture' })).toThrow(/image/);
    expect(() => validateEvidence(base(),{ kind: 'TEXT',quote: 'Power supply restored' })).not.toThrow();
  });
  it('rejects water pumping recovery as customer restoration',() => {
    const p = { ...base(),serviceType: 'WATER' };const items = [{ extraction: { result: { customer_supply: 'RESTORED',water_state: 'NORMAL',localities: [] } } }];
    expect(() => validateWaterEvidence(p,items,{ quote: 'Pumping restored to full capacity' })).toThrow(/customer/);
    expect(() => validateWaterEvidence(p,items,{ quote: 'Water supply restored to all affected areas' })).not.toThrow();
  });
  it('an older restoration cannot overwrite newer water interruption evidence',() => {
    const posts = [ { postId: 'new',faultIndex: 0,postedAt: now,effect: { status: 'INVESTIGATING',waterState: 'NO_SUPPLY',customerSupply: null,locs: [],nodeIds: [] } },{ postId: 'old',faultIndex: 0,postedAt: new Date(now-3600000),effect: { status: 'RESTORED',waterState: 'NORMAL',customerSupply: 'RESTORED',locs: [],nodeIds: [] } } ];
    expect(projectedIncident({ id: 'o',title: 'x',kind: 'UNPLANNED',status: 'ACTIVE',lastUpdateAt: now },posts,now).status).toBe('ACTIVE');
  });
  it('refuses to invent effects for legacy incident history',() => {
    expect(() => projectedIncident({ id: 'o' },[{ effect: null }])).toThrow(/historical/);
  });
});
