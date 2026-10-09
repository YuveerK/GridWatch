import { prisma as defaultDb } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { exclusive, assertLeaseInTx } from '../coordination/lease.js';
import { snapshotForPosts, restoreSnapshot } from '../processing/repair.js';
import { learnFromExtraction, removeContributions, resetLocalityIndex } from '../infrastructure/infrastructure.service.js';
import { refoldOutage } from '../outages/outage-state.js';
import { checkPostDispositions, acceptedExtraction, readingFaultItems } from '../processing/quality.js';
import { faultItems, finalStatus } from '../processing/processor.service.js';
import { extractPost } from '../ai/extraction.service.js';
import { reconcileReviewItems } from './review.service.js';
import { getCase, ensureCase, postInclude, reconcileCases, postFingerprint, casesForPost } from './cases.js';
import { planCorrection, publicPreview, WORKFLOW_ACTIONS } from './planner.js';
import { incidentInclude } from './inspection.js';
import { manualDraft } from './effective-reading.js';
import { ApplyInput, fingerprint, json, ReviewError } from './contracts.js';

function requireCorrections(type) {
  if (!WORKFLOW_ACTIONS.has(type) && env.REVIEW_CORRECTIONS_ENABLED !== 'on') throw new ReviewError('corrections_disabled','Correction controls are disabled on this server until repair and undo acceptance checks are complete.',403);
}
export async function affectedState(db, manifest) {
  const posts = await db.sourcePost.findMany({ where: { id: { in: manifest.postIds } },include: { ...postInclude,overrides: true,summaries: true,evidence: true,autoRepairDirectives: true } });
  const outages = await db.outage.findMany({ where: { id: { in: manifest.outageIds } },include: incidentInclude });
  const nodeIds = [...new Set([...posts.flatMap((p) => p.evidence.filter((e) => e.kind === 'NODE').map((e) => e.refA)),...outages.flatMap((o) => o.nodes.map((n) => n.nodeId))])];
  const nodes = nodeIds.length ? await db.infraNode.findMany({ where: { id: { in: nodeIds } },include: { aliases: true,parents: true,children: true,localities: true } }) : [];
  const canonicalRows = (rows) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,Array.isArray(value) && value.every((r) => r && typeof r === 'object' && ('id' in r || 'postId' in r || 'nodeId' in r)) ? canonicalRows(value).sort((a,b) => JSON.stringify([a.id,a.postId,a.faultIndex,a.nodeId,a.localityId,a.parentId,a.childId]).localeCompare(JSON.stringify([b.id,b.postId,b.faultIndex,b.nodeId,b.localityId,b.parentId,b.childId]))) : value]))).sort((a,b) => String(a.id ?? a.postId).localeCompare(String(b.id ?? b.postId)));
  return json({ posts: canonicalRows(posts),outages: canonicalRows(outages),nodes: canonicalRows(nodes) });
}
const stateHash = (state) => fingerprint(state);
function resultView(action) {
  return { id: action.id,type: action.type,state: action.state,result: action.result,validation: action.validation,before: action.before,after: action.after,createdAt: action.createdAt,finishedAt: action.finishedAt };
}
export async function actionStatus(caseId, actionId, db = defaultDb) {
  const action = await db.reviewAction.findFirst({ where: { id: actionId,caseId } });
  if (!action) throw new ReviewError('not_found','Action not found.',404);
  return resultView(action);
}

export async function applyCorrection(id, raw, operator, { db = defaultDb, ctx, reread = extractPost } = {}) {
  const input = ApplyInput.parse(raw);
  requireCorrections(input.correction.type);
  const prior = await db.reviewAction.findUnique({ where: { requestId: input.requestId } });
  if (prior) {
    if (prior.caseId !== id || fingerprint(prior.input) !== fingerprint(input)) throw new ReviewError('request_conflict','This request identifier belongs to a different decision.');
    return resultView(prior);
  }
  const held = await exclusive(ctx,async (lease) => {
    const duplicate = await db.reviewAction.findUnique({ where: { requestId: input.requestId } });
    if (duplicate) return resultView(duplicate);
    const preview = await planCorrection(id,{ correction: input.correction,note: input.note,evidence: input.evidence },db);
    if (preview.fingerprint !== input.fingerprint) throw new ReviewError('stale_preview','The source or incident changed since this preview. Review a fresh preview before applying.');
    await ensureCase(preview.case,db);
    if (input.correction.type === 'REREAD') {
      const start = new Date(); start.setUTCHours(0,0,0,0);
      const used = await db.reviewAction.count({ where: { type: 'REREAD',createdAt: { gte: start } } });
      if (used >= env.REVIEW_REREAD_MAX_REQUESTS_PER_DAY) throw new ReviewError('reread_budget','The daily review reread limit has been reached.',429);
    }
    const snapshot = preview.detail ? await snapshotForPosts(db,[preview.detail.post.id]) : null;
    const beforeState = await affectedState(db,preview.affected);
    if (snapshot) snapshot.reviewWorkflow = await db.reviewCase.findUnique({ where: { id },select: { workflow: true,note: true } });
    const action = await db.reviewAction.create({ data: { caseId: id,requestId: input.requestId,type: input.correction.type,state: 'APPLYING',operator,note: input.note,evidence: input.evidence,input: json(input),fingerprint: input.fingerprint,
      before: json(publicPreview(preview)),snapshot: snapshot ? json({ ...snapshot,manifest: preview.affected,beforeState,beforeHash: stateHash(beforeState) }) : undefined } });
    try {
      if (input.correction.type === 'REREAD') {
        const draft = await reread(preview.detail.post.id,{ force: true,draftOnly: true,signal: lease.signal,budget: { calls: 0,maxCalls: 2,purpose: 'extraction' } });
        const items = draft.status === 'SUCCEEDED' && draft.result ? readingFaultItems(preview.detail.post,draft,faultItems) : [];
        const reading = items.length ? manualDraft(preview.detail.post,items) : null;
        const record = await db.reviewAction.update({ where: { id: action.id },data: { state: reading ? 'PROPOSED' : 'FAILED',finishedAt: new Date(),result: json({ message: reading ? 'A proposed reading is ready. Review its differences and preview a reading correction before applying it.' : 'The reread was not accepted. The live reading and incidents were preserved.',reading,error: draft.error ?? null, inputTokens: draft.inputTokens ?? 0,outputTokens: draft.outputTokens ?? 0 }),validation: { accepted: Boolean(reading),liveDataChanged: false } } });
        return resultView(record);
      }
      const finished = await db.$transaction(async (tx) => {
        await assertLeaseInTx(tx,lease);
        if (WORKFLOW_ACTIONS.has(input.correction.type)) {
          if (input.correction.type === 'RECHECK' && preview.detail) await reconcileReviewItems({ prisma: tx,postIds: [preview.detail.post.id] });
          if (input.correction.type === 'CONFIRM' && preview.detail) {
            const post = await tx.sourcePost.findUnique({ where: { id: preview.detail.post.id },include: postInclude });
            if (casesForPost(post,null).some((c) => c.blocked && (c.faultIndex == null || c.faultIndex === preview.case.faultIndex))) throw new ReviewError('still_blocked','A blocked fault cannot be hidden by confirming the result.');
            await tx.reviewItem.updateMany({ where: { postId: post.id,...(preview.case.faultIndex == null ? {} : { faultIndex: preview.case.faultIndex }) },data: { status: 'DISMISSED',resolution: input.note,resolvedAt: new Date(),evidenceFingerprint: postFingerprint(post) } });
          }
          await tx.reviewCase.update({ where: { id },data: { workflow: input.correction.type === 'CONFIRM' ? 'CONFIRMED' : input.correction.type === 'ENGINEERING' ? 'ENGINEERING' : input.correction.type === 'DEFER' ? 'DEFERRED' : 'OPEN',note: input.note } });
        } else await executePlan(preview,tx,lease);
        const afterState = await affectedState(tx,preview.affected);
        const unresolved = preview.detail ? casesForPost(await tx.sourcePost.findUnique({ where: { id: preview.detail.post.id },include: postInclude }),null).filter((c) => c.tab === 'decision') : [];
        const result = { message: WORKFLOW_ACTIONS.has(input.correction.type) ? input.correction.type === 'ENGINEERING' ? 'Saved for engineering. Copy the investigation brief from this case.' : input.correction.type === 'DEFER' ? 'Your note is saved. This issue remains visible until it can be decided.' : input.correction.type === 'RECHECK' ? 'Rechecked stored evidence. No incident was changed.' : 'The current result was confirmed with your evidence.' : 'Correction applied and incident timelines recomputed. Validation passed.',
          incidents: preview.after.filter((o) => !o.deleted).map((o) => ({ id: o.id,title: o.title,status: o.status,waterState: o.waterState })),deletedIncidents: preview.after.filter((o) => o.deleted).map((o) => o.id),remainingConcerns: unresolved.map((c) => ({ id: c.id,title: c.title,blocked: c.blocked })),
          guardHash: stateHash(afterState),manifest: preview.affected };
        return tx.reviewAction.update({ where: { id: action.id },data: { state: 'APPLIED',finishedAt: new Date(),after: json(preview.after),result: json(result),validation: { passed: true } } });
      },{ timeout: 60000 });
      resetLocalityIndex();
      await reconcileCases({ prisma: db }).catch(() => {}); // query fallback keeps every current blocked case visible
      return resultView(finished);
    } catch (err) {
      // All deterministic writes are in one transaction. A failure rolls them back without a second repair.
      const record = await db.reviewAction.update({ where: { id: action.id },data: { state: 'FAILED',finishedAt: new Date(),validation: { passed: false,error: err.message },result: { message: err.message,code: err.code ?? 'validation_failed',liveDataChanged: false } } });
      return resultView(record);
    }
  });
  if (!held.acquired) throw new ReviewError('pipeline_busy','The pipeline is busy. No correction was stored; retry after it finishes.');
  return held.value;
}

async function executePlan(plan,tx,ctx) {
  const post = plan.detail.post;
  const beforeSiblings = post.outagePosts.filter((p) => !plan.affected.faultIndices.includes(p.faultIndex));
  const beforeDecisions = post.linkDecisions.filter((p) => !plan.affected.faultIndices.includes(p.faultIndex));
  if (plan.readingOverride) {
    await tx.readingOverride.upsert({ where: { postId: post.id },create: json(plan.readingOverride),update: json(plan.readingOverride) });
  }
  for (const index of plan.affected.faultIndices) {
    await removeContributions(post.id,index,{ ctx,db: tx });
    await tx.outagePost.deleteMany({ where: { postId: post.id,faultIndex: index } });
    await tx.linkDecision.deleteMany({ where: { postId: post.id,faultIndex: index } });
    await tx.retryAttempt.deleteMany({ where: { postId: post.id,faultIndex: index } });
    await tx.postSummary.deleteMany({ where: { postId: post.id,faultIndex: index } });
    if (plan.deletedIndices.includes(index)) await tx.linkOverride.deleteMany({ where: { postId: post.id,faultIndex: index } });
  }
  for (const o of plan.creates) await tx.outage.create({ data: { id: o.id,title: o.title,kind: o.kind,status: o.status,serviceType: o.serviceType,municipalityId: o.municipalityId,
    startedAt: o.startedAt,lastUpdateAt: o.lastUpdateAt,primaryNodeId: null,retroactive: o.retroactive,digest: o.digest,sdcName: o.sdcName } });
  for (const m of plan.mutations) {
    if (!m.exclude) {
      const facts = { ...await learnFromExtraction(m.extraction,post.publishedAt,{ source: { postId: post.id,faultIndex: m.faultIndex },mode: 'review',db: tx,ctx,serviceType: post.serviceType,municipalityId: plan.detail.account?.municipalityId ?? null }),fromDigest: m.facts.fromDigest };
      if (fingerprint(facts.nodes.map((n) => n.id)) !== fingerprint(m.facts.nodes.map((n) => n.id)) || fingerprint(facts.localityIds) !== fingerprint(m.facts.localityIds)) throw new ReviewError('identity_changed','Equipment or geography changed during the repair. No correction was applied.');
      const data = { action: m.split ? 'SPLIT' : 'JOIN',anchorPostId: m.anchor?.postId ?? null,anchorFaultIndex: m.anchor?.faultIndex ?? 0,note: plan.input.note,contrastPostId: m.split ? m.contrastPostId : null };
      await tx.linkOverride.upsert({ where: { postId_faultIndex: { postId: post.id,faultIndex: m.faultIndex } },create: { postId: post.id,faultIndex: m.faultIndex,...data },update: data });
      await tx.outagePost.create({ data: { postId: post.id,faultIndex: m.faultIndex,outageId: m.targetId,role: m.role,postedAt: post.publishedAt,effect: json(m.effect),reasons: ['Human decision from utility-post evidence'] } });
      await tx.linkDecision.create({ data: { postId: post.id,faultIndex: m.faultIndex,outageId: m.targetId,outcome: m.split ? 'NEW' : 'LINKED',reason: `manual: ${plan.input.note}` } });
      if (m.extraction.result.update_summary) await tx.postSummary.create({ data: { postId: post.id,faultIndex: m.faultIndex,summary: m.extraction.result.update_summary,model: 'human-review',promptVersion: 'human.v1' } });
    } else {
      await tx.linkOverride.deleteMany({ where: { postId: post.id,faultIndex: m.faultIndex } });
      await tx.linkDecision.create({ data: { postId: post.id,faultIndex: m.faultIndex,outcome: 'NEW',reason: `not linkable (${m.extraction.relevance}); human: ${plan.input.note}` } });
    }
  }
  for (const id of plan.affected.outageIds) await refoldOutage(tx,id);
  const updated = await tx.sourcePost.findUnique({ where: { id: post.id },include: postInclude });
  const e = acceptedExtraction(updated);
  const items = e?.result ? readingFaultItems(updated,e,faultItems) : [];
  const verdict = checkPostDispositions({ expectedIndices: items.filter((i) => plan.affected.faultIndices.includes(i.faultIndex)).map((i) => i.faultIndex),decisions: updated.linkDecisions.filter((d) => plan.affected.faultIndices.includes(d.faultIndex)),outagePosts: updated.outagePosts.filter((p) => plan.affected.faultIndices.includes(p.faultIndex)) });
  if (verdict.problems.length) throw new ReviewError('validation_failed',verdict.problems.join('; '));
  await tx.sourcePost.update({ where: { id: post.id },data: { processingStatus: finalStatus(items,updated.linkDecisions,e),processingStartedAt: new Date() } });
  if (fingerprint(beforeSiblings) !== fingerprint(updated.outagePosts.filter((p) => !plan.affected.faultIndices.includes(p.faultIndex))) || fingerprint(beforeDecisions) !== fingerprint(updated.linkDecisions.filter((p) => !plan.affected.faultIndices.includes(p.faultIndex)))) throw new ReviewError('sibling_changed','An unrelated section changed; the correction was rolled back.');
  for (const expected of plan.after) {
    const actual = await tx.outage.findUnique({ where: { id: expected.id },include: { localities: true,nodes: true } });
    if (expected.deleted ? actual : !actual || actual.status !== expected.status || actual.waterState !== expected.waterState || fingerprint(actual.localities.map((l) => [l.localityId,l.restored]).sort()) !== fingerprint(expected.areas.map((l) => [l.id,l.restored]).sort())) throw new ReviewError('preview_mismatch','The resulting incident differs from its preview. The correction was rolled back.');
  }
  await reconcileReviewItems({ prisma: tx,postIds: [post.id] });
}

export async function undoAction(id, actionId, { apply = false, fingerprint: supplied } = {}, { db = defaultDb,ctx,operator = 'cli' } = {}) {
  requireCorrections('UNDO');
  const action = await db.reviewAction.findFirst({ where: { id: actionId,caseId: id } });
  if (!action) throw new ReviewError('not_found','Action not found.',404);
  if (action.state === 'ROLLED_BACK') return { state: 'ROLLED_BACK',message: 'This correction has already been undone.' };
  if (!action.snapshot || !['APPLIED','APPLYING','RECOVERY_REQUIRED'].includes(action.state)) throw new ReviewError('undo_unavailable','This action has no applicable correction snapshot.');
  const manifest = action.result?.manifest ?? action.snapshot.manifest;
  const state = await affectedState(db,manifest);
  const currentHash = stateHash(state);
  const expectedHash = action.result?.guardHash ?? action.snapshot.beforeHash;
  if (currentHash !== expectedHash) {
    const reason = 'Newer processing changed the affected evidence. Direct undo would overwrite that work. The case is retained for engineering.';
    const rejected = await exclusive(ctx,async (lease) => db.$transaction(async (tx) => {
      await assertLeaseInTx(tx,lease);
      const liveHash = stateHash(await affectedState(tx,manifest));
      if (liveHash === expectedHash) throw new ReviewError('stale_preview','Evidence changed while checking undo. Inspect a fresh preview.');
      await tx.reviewCase.update({ where: { id },data: { workflow: 'ENGINEERING',note: reason } });
      await tx.reviewAction.upsert({ where: { requestId: `undo-conflict-${action.id}-${liveHash.slice(0,16)}` },create: { caseId: id,requestId: `undo-conflict-${action.id}-${liveHash.slice(0,16)}`,type: 'UNDO_BLOCKED',state: 'REJECTED',operator,note: reason,evidence: action.evidence,input: { actionId },fingerprint: liveHash,result: { message: reason,actionId },validation: { undoPassed: false,code: 'undo_conflict' },finishedAt: new Date() },update: {} });
    }));
    if (!rejected.acquired) throw new ReviewError('pipeline_busy','The pipeline is busy. Undo made no changes.');
    throw new ReviewError('undo_conflict',reason);
  }
  if (!apply) return { fingerprint: currentHash,before: action.after,after: action.before,state: 'PREVIEW',message: 'Undo will restore the prior reading, associations and contributions, then recompute affected incidents.' };
  if (supplied !== currentHash) throw new ReviewError('stale_preview','Review a fresh undo preview.');
  const outcome = await exclusive(ctx,async (lease) => db.$transaction(async (tx) => {
    await assertLeaseInTx(tx,lease);
    if (stateHash(await affectedState(tx,manifest)) !== currentHash) throw new ReviewError('undo_conflict','The evidence changed while undo was being prepared.');
    if (action.state === 'APPLIED' && !WORKFLOW_ACTIONS.has(action.type)) {
      // Reuse the established relative-evidence restore inside this single outer transaction.
      const adapter = new Proxy(tx,{ get(target,key) { return key === '$transaction' ? (fn) => fn(tx) : target[key]; } });
      await restoreSnapshot({ prisma: adapter,snapshot: action.snapshot,ctx: lease });
      for (const before of action.snapshot.beforeState.outages) {
        const restored = await tx.outage.findUnique({ where: { id: before.id },include: { localities: true } });
        if (!restored || restored.status !== before.status || restored.waterState !== before.waterState || fingerprint(restored.localities.map((l) => [l.localityId,l.restored]).sort()) !== fingerprint(before.localities.map((l) => [l.localityId,l.restored]).sort())) throw new ReviewError('recovery_required','Undo validation failed. The transaction was rolled back; keep the case for recovery.');
      }
    }
    await tx.reviewCase.update({ where: { id },data: { workflow: action.snapshot.reviewWorkflow?.workflow ?? 'OPEN',note: action.snapshot.reviewWorkflow?.note ?? `Undid ${actionId}: ${action.note}` } });
    await tx.reviewAction.create({ data: { caseId: id,requestId: `undo-${action.id}`,type: 'UNDO',state: 'APPLIED',operator,note: `Undo correction ${action.id}: ${action.note}`,evidence: action.evidence,input: { actionId: action.id },fingerprint: currentHash,before: action.after ?? undefined,after: action.before ?? undefined,validation: { passed: true },result: { message: 'Prior evidence and human decisions were restored.',actionId: action.id },finishedAt: new Date() } });
    await tx.reviewAction.update({ where: { id: action.id },data: { state: 'ROLLED_BACK',finishedAt: new Date(),validation: { undoPassed: true },result: { message: 'Correction undone. Prior evidence and human decisions were restored.' } } });
    return { state: 'ROLLED_BACK',message: 'Correction undone. Prior evidence and human decisions were restored.' };
  },{ timeout: 60000 }));
  if (!outcome.acquired) throw new ReviewError('pipeline_busy','The pipeline is busy. Undo made no changes.');
  resetLocalityIndex();
  await reconcileCases({ prisma: db });
  return outcome.value;
}
