import { prisma as defaultDb } from '../../db/prisma.js';
import { acceptedExtraction, readingFaultItems } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { getCase, postInclude, EXPLANATIONS } from './cases.js';
import { manualDraft } from './effective-reading.js';
import { quotedStatusId } from '../outages/linker.service.js';
import { ReviewError } from './contracts.js';

export const incidentInclude = { nodes: { include: { node: true } }, localities: { include: { locality: true } }, posts: { orderBy: [{ postedAt: 'asc' }, { faultIndex: 'asc' }, { postId: 'asc' }], include: { post: { select: { externalId: true, sourceAccount: true, text: true, noteTweetText: true, serviceType: true } } } } };
export const incidentCard = (o) => ({ id: o.id, title: o.title, serviceType: o.serviceType, kind: o.kind, status: o.status, waterState: o.waterState, startedAt: o.startedAt, lastUpdateAt: o.lastUpdateAt,
  equipment: o.nodes.map((n) => ({ id: n.node.id, name: n.node.name, type: n.node.type })), localities: o.localities.map((l) => ({ id: l.localityId, name: l.locality.canonicalName, restored: l.restored, impactBasis: l.impactBasis })),
  timeline: o.posts.map((p) => ({ postId: p.postId, faultIndex: p.faultIndex, role: p.role, postedAt: p.postedAt, text: p.post.noteTweetText || p.post.text, externalId: p.post.externalId, source: p.post.sourceAccount, effect: p.effect })) });

export async function inspectPost(postId, faultIndex, db = defaultDb) {
  const post = await db.sourcePost.findUnique({ where: { id: postId }, include: postInclude });
  if (!post) throw new ReviewError('not_found','The source post no longer exists.',404);
  const account = await db.sourceAccount.findFirst({ where: { displayName: post.sourceAccount } });
  const extraction = acceptedExtraction(post);
  const items = extraction?.result ? readingFaultItems(post,extraction,faultItems) : [];
  const item = items.find((i) => i.faultIndex === faultIndex);
  const decision = post.linkDecisions.find((d) => d.faultIndex === faultIndex) ?? null;
  const own = post.outagePosts.filter((p) => faultIndex == null || p.faultIndex === faultIndex);
  const stored = Array.isArray(decision?.candidates) ? decision.candidates : [];
  const candidateIds = [...new Set([...stored.map((c) => c.id),...own.map((p) => p.outageId)])];
  const outages = candidateIds.length ? await db.outage.findMany({ where: { id: { in: candidateIds }, serviceType: post.serviceType,
    ...(account?.municipalityId ? { OR: [{ municipalityId: account.municipalityId },{ municipalityId: null }] } : {}) }, include: incidentInclude }) : [];
  const overrides = await db.linkOverride.findMany({ where: { postId } });
  const proposals = await db.repairProposal.findMany({ where: { postId, ...(faultIndex == null ? {} : { faultIndex }) }, orderBy: { createdAt: 'desc' }, take: 10 });
  const relatedIds = [quotedStatusId(post.rawPayload),post.conversationId].filter((id) => id && id !== post.externalId);
  const related = relatedIds.length ? await db.sourcePost.findMany({ where: { externalId: { in: relatedIds }, serviceType: post.serviceType }, select: { id: true, externalId: true, text: true, noteTweetText: true, sourceAccount: true, publishedAt: true } }) : [];
  const noReadingDraft = { serviceType: post.serviceType, ...(post.serviceType === 'ELECTRICITY' ? { sdc: null } : {}), faults: [{ faultIndex: 0, relevance: 'OUTAGE', status: 'UNKNOWN', cause: null, eta_text: null, restoration_percent: null, summary: '', entities: [], localities: [], ...(post.serviceType === 'WATER' ? { water_state: 'UNKNOWN', customer_supply: null, systems: [] } : {}) }] };
  const readingDraft = items.length ? manualDraft(post,items) : noReadingDraft;
  return { post, account, extraction, items, item, decision, outages, overrides, proposals, related, readingDraft };
}

export async function inspectCase(id, db = defaultDb) {
  const c = await getCase(id,db);
  const actions = await db.reviewAction.findMany({ where: { caseId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, state: true, note: true, evidence: true, before: true, after: true, result: true, validation: true, createdAt: true, finishedAt: true } });
  if (!c.postId) {
    const outage = c.outageId ? await db.outage.findUnique({ where: { id: c.outageId },include: incidentInclude }) : null;
    const posts = outage ? await db.sourcePost.findMany({ where: { id: { in: [...new Set(outage.posts.map((p) => p.postId))] } },orderBy: { publishedAt: 'asc' },include: { ...postInclude,overrides: true } }) : [];
    const evidence = { incidents: outage ? [incidentCard(outage)] : [],evidencePosts: posts.map((p) => {
      const e = acceptedExtraction(p);
      return { id: p.id,externalId: p.externalId,source: p.sourceAccount,publishedAt: p.publishedAt,text: p.noteTweetText || p.text,url: `https://x.com/${p.sourceAccount}/status/${p.externalId}`,
        media: p.PostMedia.map((m) => ({ mediaKey: m.mediaKey,type: m.mediaType,url: m.url })),imageText: e?.imageText ?? e?.result?.image_text ?? null,related: [] };
    }),evidenceInterpretations: posts.map((p) => {
      const e = acceptedExtraction(p);
      const items = e?.result ? readingFaultItems(p,e,faultItems) : [];
      return { postId: p.id,externalId: p.externalId,reading: e?.result ?? null,decisions: p.linkDecisions,overrides: p.overrides,readingOverride: p.readingOverride,
        sections: items.filter((i) => outage.posts.some((op) => op.postId === p.id && op.faultIndex === i.faultIndex)).map((i) => ({ faultIndex: i.faultIndex,meaning: i.extraction.relevance,
          label: i.extraction.result.entities?.map((a) => a.name).join(', ') || i.extraction.result.localities?.map((a) => a.name).join(', ') || 'Source section',
          status: i.extraction.result.status,summary: i.extraction.result.update_summary ?? i.extraction.result.summary,restorationPercent: i.extraction.result.restoration_percent,
          waterState: i.extraction.result.water_state,customerSupply: i.extraction.result.customer_supply })) };
    }) };
    return { ...c,...evidence,health: { accounts: c.health.accounts,problems: c.health.problems,quality: c.health.quality },actions,
      allowedActions: ['DEFER','ENGINEERING','RECHECK'],explanations: c.reasons.map((r) => ({ ...r,explanation: EXPLANATIONS[r.code]?.[1] ?? r.detail })),brief: engineeringBrief(c,null,actions,evidence) };
  }
  const d = await inspectPost(c.postId,c.faultIndex,db);
  const allowedActions = ['DEFER','ENGINEERING','RECHECK',...(!c.blocked ? ['CONFIRM'] : []),'READING','REREAD'];
  if (d.item && ['OUTAGE','UPDATE','RESTORATION','PLANNED_OUTAGE'].includes(d.item.extraction.relevance)) allowedActions.push('JOIN','SPLIT');
  if (d.items.length) allowedActions.push('RETRY_STORED');
  return { ...c, health: undefined, sourcePost: { id: d.post.id, externalId: d.post.externalId, source: d.post.sourceAccount, publishedAt: d.post.publishedAt,
    text: d.post.noteTweetText || d.post.text, url: `https://x.com/${d.post.sourceAccount}/status/${d.post.externalId}`, media: d.post.PostMedia.map((m) => ({ mediaKey: m.mediaKey, type: m.mediaType, url: m.url })), imageText: d.extraction?.imageText ?? d.extraction?.result?.image_text ?? d.post.extractions[0]?.imageText ?? null,
    related: d.related, processingStatus: d.post.processingStatus },
    reading: d.item?.extraction.result ?? (c.faultIndex == null ? d.extraction?.result : null) ?? null, readingDraft: d.readingDraft, readingOrigin: d.extraction?.human ? 'human' : 'machine', readingConflict: d.extraction?.humanConflict ?? false,
    readingVersion: d.extraction?.promptVersion ?? null, historicalReadings: d.post.extractions.map((e) => ({ status: e.status, promptVersion: e.promptVersion, createdAt: e.createdAt, error: e.error })),
    faults: d.items.map((i) => ({ faultIndex: i.faultIndex, label: i.extraction.result.entities?.map((a) => a.name).join(', ') || i.extraction.result.localities?.map((a) => a.name).join(', ') || 'Source post', relevance: i.extraction.relevance, status: i.extraction.result.status,
      decision: d.post.linkDecisions.find((x) => x.faultIndex === i.faultIndex) ?? null })),
    decision: d.decision, incidents: d.outages.map(incidentCard), candidates: d.outages.filter((o) => (d.decision?.candidates ?? []).some((x) => x.id === o.id)).map((o) => ({ ...incidentCard(o), match: d.decision.candidates.find((x) => x.id === o.id) })),
    retries: d.post.retries, overrides: d.overrides, readingOverride: d.post.readingOverride ? { revision: d.post.readingOverride.revision, note: d.post.readingOverride.note, evidence: d.post.readingOverride.evidence } : null,
    proposals: d.proposals, actions, allowedActions, explanations: c.reasons.map((r) => ({ ...r, explanation: EXPLANATIONS[r.code]?.[1] ?? r.detail })), brief: engineeringBrief(c,d,actions),
  };
}

export async function candidateSearch(id, { q = '', offset = 0, limit = 20 } = {}, db = defaultDb) {
  const c = await getCase(id,db);
  if (!c.postId) return { data: [], total: 0 };
  const d = await inspectPost(c.postId,c.faultIndex,db);
  const where = { serviceType: d.post.serviceType, ...(d.account?.municipalityId ? { OR: [{ municipalityId: d.account.municipalityId },{ municipalityId: null }] } : {}),
    ...(q ? { AND: [{ OR: [{ title: { contains: q, mode: 'insensitive' } },{ posts: { some: { post: { externalId: q } } } },{ nodes: { some: { node: { name: { contains: q, mode: 'insensitive' } } } } }] }] } : {}),
    posts: { some: { OR: [{ postId: { not: c.postId } },{ faultIndex: { not: c.faultIndex ?? -1 } }] } } };
  const [rows,total] = await Promise.all([db.outage.findMany({ where,include: incidentInclude, orderBy: [{ lastUpdateAt: 'desc' },{ id: 'asc' }],skip: offset,take: limit }),db.outage.count({ where })]);
  return { data: rows.map(incidentCard),total,offset,limit,hasMore: offset+limit < total };
}

export function engineeringBrief(c,d,actions = [],incidentEvidence = null) {
  const lines = [`# GridWatch review: ${c.title}`, '', `Case: /review/${c.id}`, `Subject: ${c.subjectKey}`, `Service/source: ${c.serviceType ?? 'pipeline'} / ${c.source ?? 'all'}`, `Concern: ${c.reasons.map((r) => `${r.code}: ${r.detail ?? EXPLANATIONS[r.code]?.[1]}`).join('; ')}`, `Expected: resolve the source-supported interpretation/association and verify all affected timelines.`, ''];
  if (d) lines.push(`Post: ${d.post.externalId} (database ${d.post.id}), fault ${c.faultIndex ?? 'whole reading'}`, `Source: https://x.com/${d.post.sourceAccount}/status/${d.post.externalId}`, `Published: ${d.post.publishedAt.toISOString()}`, '', '## Original source', d.post.noteTweetText || d.post.text, '', '## Image evidence', [d.extraction?.imageText || d.extraction?.result?.image_text || '(transcription not available)',...d.post.PostMedia.map((m) => `${m.mediaKey}: ${m.url}`)].join('\n'), '', '## Mechanism', JSON.stringify({ reading: d.item?.extraction.result ?? (c.faultIndex == null ? d.extraction?.result : null), decision: d.decision, effects: d.post.outagePosts, candidates: d.outages.map(incidentCard), overrides: d.overrides, readingOverride: d.post.readingOverride, proposals: d.proposals },null,2));
  if (incidentEvidence?.incidents.length) {
    lines.push('## Affected incident and complete timeline',JSON.stringify(incidentEvidence.incidents,null,2),'','## Original utility evidence');
    for (const p of incidentEvidence.evidencePosts) lines.push(`Post ${p.externalId} (database ${p.id})`,p.url,p.text,p.imageText ?? '(transcription unavailable)',...p.media.map((m) => `${m.mediaKey}: ${m.url}`),'');
    lines.push('## Accepted readings, decisions and existing human overrides',JSON.stringify(incidentEvidence.evidenceInterpretations,null,2));
  }
  lines.push('', '## Already attempted', JSON.stringify(actions,null,2), '', '## Investigation instructions',
    'Read CLAUDE.md. Distinguish a reusable engine bug from exceptional source ambiguity. Inspect reading, selected fault, candidate reasons and OutagePost.effect.',
    'Association: outages/scoring.js and linker.service.js. Status: outage-state.js and water-state.js. Reading: service-specific reader/schema. Identity/geography: infrastructure.service.js. Operational work: processing/cycle.js and quality.js.',
    'Fix the general mechanism and add a real-shape regression test. Do not patch an outage row, hard-code an ID, suppress checks, or treat Water recovery as customer restoration.',
    'Validate both services with npm test and npm run test:integration. Recheck this exact stored window with npm run batch -- --from=<ISO> --to=<ISO>; then npm run audit and npm run eval:all. Do not advance the latest-post checkpoint for this investigation.',
    'Recheck the case after the repair; copying this brief alone does not resolve it.');
  return lines.join('\n');
}
