import { acceptedExtraction, readingFaultItems } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { learnFromExtraction } from '../infrastructure/infrastructure.service.js';
import { buildEffect, foldEffects, keptLifecycleStatus, noticeEffect } from '../outages/outage-state.js';
import { validateOverrideGraph } from '../outages/overrides.js';
import { isPlanned, titleFor } from '../outages/linker.service.js';
import { scheduleWindow } from '../../lib/schedule.js';
import { readingRevision } from '../../lib/reading-revision.js';
import { effectiveExtraction } from './effective-reading.js';
import { inspectPost, incidentInclude } from './inspection.js';
import { getCase } from './cases.js';
import { fingerprint, identityId, json, ReviewError, PreviewInput, sourceHash, sourceMediaHash } from './contracts.js';

export const WORKFLOW_ACTIONS = new Set(['CONFIRM','DEFER','ENGINEERING','RECHECK']);
const LINKABLE = new Set(['OUTAGE','UPDATE','RESTORATION','PLANNED_OUTAGE']);
export function validateEvidence(post, evidence) {
  const normalize = (s) => String(s ?? '').replace(/\s+/g,' ').trim().toLowerCase();
  const quote = normalize(evidence.quote);
  const text = normalize(post.noteTweetText || post.text);
  if (evidence.kind === 'TEXT' && !text.includes(quote)) throw new ReviewError('missing_evidence','Quote the relevant words from the original utility post.',400);
  if (evidence.kind === 'IMAGE' && !(post.PostMedia ?? []).some((m) => m.mediaType === 'photo' && (!evidence.mediaKey || m.mediaKey === evidence.mediaKey))) throw new ReviewError('missing_evidence','Select an attached utility image as the evidence.',400);
}
export function validateWaterEvidence(post, items, evidence) {
  if (post.serviceType !== 'WATER') return;
  // A human must explicitly identify CUSTOMER supply, not just infrastructure recovery.
  const explicit = /water\s+supply\s+(?:has been\s+|is\s+)?restored|supply\s+(?:has been\s+|is\s+)?restored\s+to\s+(?:all|customers|affected)|customers\s+(?:are\s+)?(?:receiving|have)\s+(?:normal\s+)?water|system\s+(?:is\s+)?supplying\s+normally|water\s+(?:has been\s+|is\s+)?restored\s+to/i;
  for (const i of items) if (i.extraction.result.customer_supply === 'RESTORED' || i.extraction.result.water_state === 'NORMAL' || i.extraction.result.localities?.some((l) => l.impact === 'RESTORED')) {
    if (!explicit.test(evidence.quote)) throw new ReviewError('customer_evidence_required','Quote explicit customer water-supply restoration. Pumping, repairs, bypass and recovering levels do not establish restored supply.',400);
  }
}
export async function validateAnchor(db, post, index, target, unavailable = new Set()) {
  if (target.serviceType !== post.serviceType) throw new ReviewError('incompatible_target','Water and Electricity cannot share an incident.',400);
  const account = await db.sourceAccount.findFirst({ where: { displayName: post.sourceAccount } });
  if (account?.municipalityId && target.municipalityId && account.municipalityId !== target.municipalityId) throw new ReviewError('incompatible_target','This incident belongs to another municipality.',400);
  const anchors = target.posts.filter((p) => (p.postId !== post.id || p.faultIndex !== index) && !unavailable.has(`${p.postId}:${p.faultIndex}`)).sort((a,b) => Number(a.postId === post.id)-Number(b.postId === post.id));
  for (const anchor of anchors) {
    const visited = new Set([`${post.id}:${index}`]);
    let next = { postId: anchor.postId, faultIndex: anchor.faultIndex };
    let cycle = false;
    for (;;) {
      const key = `${next.postId}:${next.faultIndex}`;
      if (visited.has(key)) { cycle = true; break; }
      visited.add(key);
      const o = await db.linkOverride.findUnique({ where: { postId_faultIndex: next } });
      if (!o || o.action !== 'JOIN') break;
      next = { postId: o.anchorPostId, faultIndex: o.anchorFaultIndex };
    }
    if (!cycle) return { postId: anchor.postId, faultIndex: anchor.faultIndex };
  }
  throw new ReviewError('invalid_anchor','The target has no independent, non-cyclic source-post anchor.',400);
}

export function projectedIncident(outage, posts, now = new Date()) {
  if (!posts.length) return { id: outage.id, title: outage.title, deleted: true, status: null, areas: [], entries: [] };
  if (posts.some((p) => !p.effect)) throw new ReviewError('legacy_evidence','This incident has historical entries without effects. It needs engineering reconstruction before a safe preview is possible.');
  const counts = new Map();
  for (const p of posts) counts.set(p.postId,(counts.get(p.postId) ?? new Set()).add(p.faultIndex));
  const folded = foldEffects(posts.map((p) => ({ ...p, postedAt: new Date(p.postedAt), effect: noticeEffect({ ...p, post: { ...p.post, faultCount: counts.get(p.postId).size } }) })));
  const status = keptLifecycleStatus({ foldedStatus: folded.status, kind: outage.kind, lastUpdateAt: folded.lastUpdateAt, previousStatus: outage.status, previousLastUpdateAt: outage.lastUpdateAt,
    windowAhead: outage.kind === 'PLANNED' && folded.schedule?.end && new Date(folded.schedule.end) > now });
  return { id: outage.id, title: outage.title, deleted: false, kind: outage.kind, status, waterState: folded.waterState, startedAt: folded.startedAt, lastUpdateAt: folded.lastUpdateAt,
    restoredAt: folded.restoredAt, restorationPercent: folded.restorationPercent, cause: folded.cause, eta: folded.etaText, schedule: folded.schedule,
    nodeIds: [...folded.nodeIds], areas: [...folded.localities].map(([id,restored]) => ({ id,restored })), entries: posts.map((p) => ({ postId: p.postId,faultIndex: p.faultIndex,role: p.role,postedAt: p.postedAt,effect: p.effect,text: p.post?.noteTweetText || p.post?.text || null,externalId: p.post?.externalId ?? null,source: p.post?.sourceAccount ?? null })) };
}

export async function planCorrection(id, input, db) {
  const parsed = PreviewInput.parse(input);
  const c = await getCase(id,db);
  const { correction, evidence } = parsed;
  const d = c.postId ? await inspectPost(c.postId,c.faultIndex,db) : null;
  if (d) validateEvidence(d.post,evidence);
  if (correction.type === 'CONFIRM' && c.blocked) throw new ReviewError('still_blocked','This condition is still blocked. Correct the reading or association instead of closing its flag.');
  if (!d && !WORKFLOW_ACTIONS.has(correction.type)) throw new ReviewError('unsupported_action','This pipeline issue requires inspection or an engineering handoff.',400);
  const initial = fingerprint({ case: c.fingerprint, correction, source: d ? sourceHash(d.post) : null });
  if (WORKFLOW_ACTIONS.has(correction.type) || correction.type === 'REREAD') return { case: c, detail: d, input: parsed, fingerprint: initial, providerCalls: correction.type === 'REREAD' ? 'One staged reread (up to two provider attempts); live interpretation stays unchanged.' : 'None', before: [], after: [], changes: [], mutations: [], affected: { postIds: d ? [d.post.id] : [], outageIds: [] } };
  let extraction = d.extraction;
  let readingOverride = null;
  if (correction.type === 'READING') {
    if (correction.reading.serviceType !== d.post.serviceType) throw new ReviewError('incompatible_reading','The reading must use the source service.',400);
    const existingIndices = new Set(d.items.map((i) => i.faultIndex));
    const maxIndex = Math.max(-1,...existingIndices,...d.overrides.map((o) => o.faultIndex));
    for (const f of correction.reading.faults) if (!existingIndices.has(f.faultIndex) && f.faultIndex <= maxIndex) throw new ReviewError('fault_identity','New sections must use new fault identities; do not renumber existing sections.',400);
    const removed = d.items.filter((i) => !correction.reading.faults.some((f) => f.faultIndex === i.faultIndex));
    const dependedOn = removed.length ? await db.linkOverride.findMany({ where: { anchorPostId: d.post.id, anchorFaultIndex: { in: removed.map((f) => f.faultIndex) } } }) : [];
    if (dependedOn.length) throw new ReviewError('anchor_dependency','Another human correction depends on a section being removed. Resolve that dependency first.');
    readingOverride = { postId: d.post.id, schemaVersion: 1, serviceType: d.post.serviceType, sourceHash: sourceHash(d.post), baseReadingHash: d.extraction?.result ? fingerprint(d.extraction.result) : null,
      payload: { sourceMediaHash: sourceMediaHash(d.post), sourceTextHash: fingerprint({ service: d.post.serviceType,text: d.post.noteTweetText || d.post.text }), reading: correction.reading }, evidence, note: parsed.note, revision: (d.post.readingOverride?.revision ?? 0)+1 };
    extraction = effectiveExtraction({ ...d.post,readingOverride },d.extraction);
  }
  if (!extraction?.result || extraction.status !== 'SUCCEEDED') throw new ReviewError('missing_reading','No accepted reading is available. Correct the reading or request a staged reread first.');
  const items = readingFaultItems(d.post,extraction,faultItems);
  const selected = correction.type === 'READING' || correction.type === 'RETRY_STORED' ? items : items.filter((i) => i.faultIndex === c.faultIndex);
  if (!selected.length) throw new ReviewError('missing_fault','This section no longer exists in the current reading. Reopen the case and check its current sections.');
  validateWaterEvidence(d.post,selected,evidence);
  const deletedIndices = correction.type === 'READING' ? d.items.filter((i) => !items.some((n) => n.faultIndex === i.faultIndex)).map((i) => i.faultIndex) : [];
  const changedIndices = [...selected.map((i) => i.faultIndex),...deletedIndices];
  const targetIds = [...new Set([...(correction.type === 'JOIN' ? [correction.targetOutageId] : []),...(correction.type === 'READING' ? correction.placements.map((p) => p.targetOutageId).filter(Boolean) : []),...d.post.outagePosts.filter((p) => changedIndices.includes(p.faultIndex)).map((p) => p.outageId)])];
  const outages = targetIds.length ? await db.outage.findMany({ where: { id: { in: targetIds } },include: incidentInclude }) : [];
  if (targetIds.some((id) => !outages.some((o) => o.id === id))) throw new ReviewError('stale_target','An affected incident no longer exists. Refresh the case.');
  const mutations = [];
  const creates = [];
  for (const item of selected) {
    const current = d.post.outagePosts.find((p) => p.faultIndex === item.faultIndex);
    const explicit = correction.type === 'READING' ? correction.placements.find((p) => p.faultIndex === item.faultIndex) : null;
    const exclude = !LINKABLE.has(item.extraction.relevance);
    if (exclude) { mutations.push({ faultIndex: item.faultIndex, exclude: true, extraction: item.extraction, oldOutageId: current?.outageId ?? null }); continue; }
    let targetId = correction.type === 'JOIN' ? correction.targetOutageId : correction.type === 'SPLIT' ? null : explicit ? explicit.targetOutageId : current?.outageId;
    if (targetId === undefined) throw new ReviewError('decision_required',`Choose an existing incident or a separate incident for section ${item.faultIndex}.`,400);
    let target = targetId ? outages.find((o) => o.id === targetId) : null;
    const facts = { ...await learnFromExtraction(item.extraction,d.post.publishedAt,{ mode: 'preview',serviceType: d.post.serviceType,municipalityId: d.account?.municipalityId ?? null,db }), fromDigest: item.fromDigest };
    if (!facts.nodes.length && !facts.localityIds.length) throw new ReviewError('missing_identity','An incident needs source-supported equipment or an area. Correct the reading or hand this case to engineering.',400);
    let anchor = null;
    const unavailable = new Set(deletedIndices.map((i) => `${d.post.id}:${i}`));
    if (target) for (const sibling of selected) {
      const placement = correction.type === 'READING' ? correction.placements.find((p) => p.faultIndex === sibling.faultIndex) : null;
      const destination = placement ? placement.targetOutageId : d.post.outagePosts.find((p) => p.faultIndex === sibling.faultIndex)?.outageId;
      if (!LINKABLE.has(sibling.extraction.relevance) || correction.type === 'SPLIT' || destination !== target.id) unavailable.add(`${d.post.id}:${sibling.faultIndex}`);
    }
    const preservedRoot = target && current?.outageId === target.id && correction.type !== 'JOIN' && target.posts.every((p) => p.postId === d.post.id) && (target.posts.find((p) => p.role === 'OPENED') ?? target.posts[0])?.faultIndex === item.faultIndex;
    if (target && !preservedRoot) anchor = await validateAnchor(db,d.post,item.faultIndex,target,unavailable);
    const kind = isPlanned(item.extraction,item.fromDigest ? '' : d.post.noteTweetText || d.post.text) ? 'PLANNED' : 'UNPLANNED';
    if (target && target.kind !== kind) throw new ReviewError('incompatible_kind','Planned and unplanned incidents must remain separate. Correct the post meaning if it was read incorrectly.',400);
    if (!target) {
      const newId = identityId(['outage',d.post.id,item.faultIndex,initial]);
      target = { id: newId,title: titleFor(facts,item.extraction),kind,status: 'ACTIVE',serviceType: d.post.serviceType,municipalityId: d.account?.municipalityId ?? null,
        startedAt: d.post.publishedAt,lastUpdateAt: d.post.publishedAt,posts: [],nodes: [],localities: [],primaryNodeId: facts.nodes.at(-1)?.id ?? null,
        retroactive: item.extraction.relevance === 'RESTORATION',digest: false,sdcName: facts.sdcNode?.name ?? null };
      creates.push(target);
    }
    const effect = buildEffect({ extraction: item.extraction,facts,post: { kind, schedule: kind === 'PLANNED' ? scheduleWindow(item.extraction,item.fromDigest ? '' : d.post.noteTweetText || d.post.text,d.post.publishedAt) : null },
      retroactive: Boolean(target.retroactive),expand: true,revision: readingRevision(extraction.result) });
    const role = item.extraction.relevance === 'RESTORATION' ? 'RESTORATION' : creates.includes(target) ? 'OPENED' : current?.outageId === target.id && current.role === 'OPENED' ? 'OPENED' : 'UPDATE';
    mutations.push({ faultIndex: item.faultIndex,extraction: item.extraction,facts,anchor,targetId: target.id,oldOutageId: current?.outageId ?? null,role,effect,
      split: !anchor,contrastPostId: current ? outages.find((o) => o.id === current.outageId)?.posts.find((p) => p.postId !== d.post.id)?.postId ?? null : null });
  }
  try { await validateOverrideGraph(mutations.map((m) => ({ postId: d.post.id,faultIndex: m.faultIndex,action: m.exclude || m.split ? 'SPLIT' : 'JOIN',anchorPostId: m.anchor?.postId,anchorFaultIndex: m.anchor?.faultIndex })),db); }
  catch (err) { throw new ReviewError('invalid_anchor',err.message,400); }
  const before = outages.map((o) => projectedIncident(o,o.posts));
  const allOutages = [...outages,...creates];
  const after = allOutages.map((o) => {
    const remaining = o.posts.filter((p) => !(p.postId === d.post.id && changedIndices.includes(p.faultIndex)));
    const added = mutations.filter((m) => m.targetId === o.id).map((m) => ({ postId: d.post.id,faultIndex: m.faultIndex,postedAt: d.post.publishedAt,role: m.role,effect: m.effect,post: d.post }));
    return projectedIncident(o,[...remaining,...added]);
  });
  const affected = { postIds: [d.post.id],outageIds: allOutages.map((o) => o.id), faultIndices: changedIndices };
  const signature = fingerprint({ initial, outages: json(outages), readingOverride, mutations: mutations.map((m) => ({ index: m.faultIndex,target: m.targetId,effect: m.effect,anchor: m.anchor,facts: m.facts })),
    overrides: d.overrides, autoDirectives: await db.autoRepairDirective.findMany({ where: { postId: d.post.id } }) });
  const localities = await db.locality.findMany({ where: { id: { in: [...new Set([...before,...after].flatMap((o) => o.areas.map((a) => a.id)))] } },select: { id: true,canonicalName: true } });
  const areaName = (id) => localities.find((l) => l.id === id)?.canonicalName ?? selected.flatMap((i) => i.extraction.result.localities).find((l) => identityId(['locality',d.account?.municipalityId ?? null,l.name.toLowerCase()]) === id)?.name ?? 'New source-supported area';
  for (const o of [...before,...after]) o.areas = o.areas.map((a) => ({ ...a,name: areaName(a.id) }));
  return { case: c,detail: d,input: parsed,fingerprint: signature,providerCalls: 'None — stored utility evidence only.',before,after,mutations,creates,readingOverride,deletedIndices,affected,
    changes: [...mutations.map((m) => ({ faultIndex: m.faultIndex,label: m.extraction.result.entities?.[0]?.name || m.extraction.result.localities?.[0]?.name || 'Source section',from: m.oldOutageId,to: m.targetId ?? null,meaning: m.extraction.relevance,role: m.role ?? 'EXCLUDED' })),...deletedIndices.map((faultIndex) => ({ faultIndex,from: d.post.outagePosts.find((p) => p.faultIndex === faultIndex)?.outageId ?? null,to: null,role: 'REMOVED' }))],
    siblings: d.items.filter((i) => !changedIndices.includes(i.faultIndex)).map((i) => ({ faultIndex: i.faultIndex,unchanged: true })) };
}

export function publicPreview(plan) {
  return json({ fingerprint: plan.fingerprint,providerCalls: plan.providerCalls,before: plan.before,after: plan.after,changes: plan.changes,affected: plan.affected,siblings: plan.siblings ?? [],type: plan.input.correction.type,
    label: plan.input.correction.type === 'JOIN' ? 'Attach this fault and recompute incidents' : plan.input.correction.type === 'SPLIT' ? 'Keep this as a separate incident' : plan.input.correction.type === 'READING' ? 'Apply reading correction and recompute incidents' : plan.input.correction.type === 'REREAD' ? 'Request a proposed AI reading' : 'Save this decision' });
}
