export const REVIEW_TABS = [ ['decision','Needs your decision'],['waiting','Waiting automatically'],['engineering','Needs engineering'],['history','History'] ];
export const ACTION_LABELS = { LEGACY_REVIEW: 'Previous review', JOIN: 'Attach to an existing outage',SPLIT: 'Keep this as a separate incident',READING: 'Correct what this post means',RETRY_STORED: 'Reapply the stored reading',REREAD: 'Request a proposed AI reading',CONFIRM: 'The current result is correct',DEFER: 'I cannot decide yet',ENGINEERING: 'Needs engineering',RECHECK: 'Recheck current evidence' };
export const RELEVANCE_LABELS = { OUTAGE: 'New interruption',UPDATE: 'Update to an interruption',RESTORATION: 'Restoration',PLANNED_OUTAGE: 'Planned maintenance',GENERAL_NOTICE: 'Informational notice',IRRELEVANT: 'Not outage information',SDC_SUMMARY: 'Multiple incident bulletin' };
export function reviewQuery(search) {
  const get = (key,fallback) => search.get(key) || fallback;
  return { tab: get('tab','decision'),service: get('service','ALL'),source: get('source',''),municipality: get('municipality',''),category: get('category',''),age: get('age','all'),q: get('q',''),sampled: get('sampled','false'),offset: Number(get('offset','0')),limit: 50 };
}
export function queryString(query) { return new URLSearchParams(Object.entries(query).filter(([,v]) => v !== '' && v != null)).toString(); }
export function newFault(reading) {
  return { faultIndex: Math.max(-1,...reading.faults.map((f) => f.faultIndex))+1,relevance: 'OUTAGE',status: 'UNKNOWN',cause: null,eta_text: null,restoration_percent: null,summary: '',entities: [],localities: [],...(reading.serviceType === 'WATER' ? { water_state: 'UNKNOWN',customer_supply: null,systems: [] } : {}) };
}
export function readingDiff(previous,next) {
  const before = new Map(previous.faults.map((f) => [f.faultIndex,f]));
  const after = new Map(next.faults.map((f) => [f.faultIndex,f]));
  return [...new Set([...before.keys(),...after.keys()])].map((index) => ({ index,before: before.get(index),after: after.get(index) })).filter((r) => JSON.stringify(r.before) !== JSON.stringify(r.after));
}

export function timelineChanges(previous,next) {
  const key = (p) => `${p.postId}:${p.faultIndex}`;
  const before = new Map((previous ?? []).map((p) => [key(p),p]));
  const after = new Map((next ?? []).map((p) => [key(p),p]));
  return [...new Set([...before.keys(),...after.keys()])].map((id) => ({ id,before: before.get(id),after: after.get(id) }))
    .filter((r) => !r.before || !r.after || r.before.role !== r.after.role || JSON.stringify(r.before.effect) !== JSON.stringify(r.after.effect));
}
