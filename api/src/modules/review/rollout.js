import { acceptedExtraction, assessCycle, beginCycleQuality, effectReadingMismatch, failCycleQuality } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { detectSuspicious, saveReviewItems } from './review.service.js';
import { casesForPost, collectCases, ensureCase, postFingerprint, postInclude, reconcileCases } from './cases.js';
import { fingerprint, json } from './contracts.js';
import { previewProposals } from '../self-correction/service.js';
import { env } from '../../config/env.js';

// Legacy decisions have no evidence hash. Carry one forward only when the original records prove no later processing occurred.
export function legacyAcknowledgementIsCurrent(post, item, finding) {
  if (item.status === 'OPEN' || !item.resolvedAt || !item.resolution?.trim() || item.resolution === 'condition no longer present') return false;
  if (!finding.reasons.every((r) => item.reasons.some((old) => old.code === r.code && old.detail === r.detail))) return false;
  if (item.evidenceFingerprint) return item.evidenceFingerprint === postFingerprint(post);
  const resolved = new Date(item.resolvedAt).getTime();
  const reading = acceptedExtraction(post);
  if (!reading?.result || !Number.isFinite(resolved)) return false;
  const dates = [post.updatedAt,post.processingStartedAt,reading.createdAt,...post.linkDecisions.map((d) => d.createdAt),...post.PostMedia.map((m) => m.createdAt),
    post.readingOverride?.updatedAt,...(post.overrides ?? []).map((o) => o.updatedAt ?? o.createdAt)];
  if (dates.some((d) => d && new Date(d).getTime() > resolved)) return false;
  if (!post.updatedAt || !post.processingStartedAt || !reading.createdAt || !post.linkDecisions.length) return false;
  // A cached extraction can be overwritten in place. Its semantic revision must still agree with the original timeline effects.
  if (post.outagePosts.some((p) => !p.effect?.reading || effectReadingMismatch(p.effect,reading.result) !== false)) return false;
  return true;
}

export async function planReviewBackfill(db, limit = 500) {
  const posts = await db.sourcePost.findMany({ orderBy: { id: 'asc' },include: { ...postInclude,overrides: true } });
  const findings = await detectSuspicious({ prisma: db,postIds: posts.map((p) => p.id) });
  const changes = [];
  for (const finding of findings) {
    const post = posts.find((p) => p.id === finding.postId);
    const item = post.reviewItems.find((i) => i.faultIndex === finding.faultIndex);
    if (item?.status === 'OPEN') continue;
    const acknowledged = item && legacyAcknowledgementIsCurrent(post,item,finding);
    if (acknowledged && item.evidenceFingerprint) continue;
    changes.push({ post,item,finding,acknowledged: Boolean(acknowledged) });
  }
  return { posts,findings,changes: changes.slice(0,limit),remaining: Math.max(0,changes.length-limit) };
}

async function preserveLegacyReview(db, post, item, finding, acknowledged) {
  const subject = casesForPost({ ...post,reviewItems: [{ ...item,status: 'OPEN' }] },null).find((c) => c.faultIndex === item.faultIndex) ??
    casesForPost({ ...post,reviewItems: [{ ...item,status: 'OPEN' }] },null).find((c) => c.reasons.some((r) => item.reasons.some((i) => i.code === r.code)));
  if (!subject) return;
  const c = { ...subject,blocked: false,tab: 'history',workflow: 'CONFIRMED',note: item.resolution,createdAt: item.createdAt };
  await ensureCase(c,db);
  await db.reviewAction.upsert({ where: { requestId: `legacy-review:${item.id}` },update: {},create: {
    caseId: c.id,requestId: `legacy-review:${item.id}`,type: 'LEGACY_REVIEW',state: 'APPLIED',operator: 'rollout',note: item.resolution ?? 'Historical review disposition',
    evidence: { kind: 'LEGACY_REVIEW',reviewItemId: item.id,resolvedAt: item.resolvedAt },input: { status: item.status,reasons: item.reasons },
    fingerprint: fingerprint(item),before: json(item),finishedAt: item.resolvedAt,createdAt: item.resolvedAt ?? item.createdAt,
    validation: { migration: true,newHumanDecision: false,evidenceUnchanged: acknowledged },result: { message: acknowledged ? 'Historical decision preserved: its evidence and processing predate the acknowledgement.' : 'Historical decision retained. The current concern requires a new review because its evidence version cannot be verified.' },
  } });
  return c;
}

export async function backfillReview(db, { limit = 500,apply = false,ctx } = {}) {
  const plan = await planReviewBackfill(db,limit);
  const summary = { storedPosts: plan.posts.length,findings: plan.findings.length,missingOrChanged: plan.changes.filter((c) => !c.acknowledged).length,
    legacyAcknowledgements: plan.changes.filter((c) => c.acknowledged).length,remainingFindings: plan.remaining };
  if (!apply) return { ...summary,readOnly: true };
  ctx?.assertHeld();
  for (const change of plan.changes) await db.$transaction(async (tx) => {
    if (ctx) { const { assertLeaseInTx } = await import('../coordination/lease.js');await assertLeaseInTx(tx,ctx); }
    if (change.item) {
      const legacy = await preserveLegacyReview(tx,change.post,change.item,change.finding,change.acknowledged);
      if (legacy && !change.acknowledged) await tx.reviewCase.update({ where: { id: legacy.id },data: { workflow: 'OPEN',note: `Previous review: ${change.item.resolution ?? 'No explanation recorded'}. Recheck the current evidence; its historical version could not be verified.` } });
    }
    if (change.acknowledged) await tx.reviewItem.update({ where: { id: change.item.id },data: { evidenceFingerprint: postFingerprint(change.post) } });
    else if (change.item) await tx.reviewItem.update({ where: { id: change.item.id },data: { status: 'OPEN',resolvedAt: null,resolution: null,evidenceFingerprint: null,reasons: change.finding.reasons } });
    else await saveReviewItems({ prisma: tx,suspicions: [change.finding] });
  });
  const indexed = await reconcileCases({ prisma: db,limit });
  return { ...summary,...indexed,readOnly: false };
}

// An explicit stored-evidence check is not a fetch or a replay. It records what actually ran and preserves ingestion timestamps.
export async function checkStoredReview(db, ctx) {
  const startedAt = new Date();
  const { id } = await beginCycleQuality({ prisma: db,trigger: 'review-rollout-stored-evidence',startedAt });
  try {
    ctx?.assertHeld();
    const posts = await db.sourcePost.findMany({ select: { id: true } });
    const proposed = await previewProposals({ prisma: db,postIds: posts.map((p) => p.id),limit: env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE });
    await reconcileCases({ prisma: db,limit: 500 });
    const accounts = await db.sourceAccount.findMany({ where: { active: true },select: { displayName: true } });
    const result = await assessCycle({ prisma: db,faultItems,promptVersion: env.AI_PROMPT_VERSION,trigger: 'review-rollout-stored-evidence',startedAt,qualityId: id,postIds: posts.map((p) => p.id),
      selfCorrection: { ran: true,generated: proposed.length,persisted: 0,applied: 0,checkOnly: true },sourceChecks: accounts.map((a) => ({ source: a.displayName,checkedAt: new Date().toISOString(),incomplete: false })) });
    return { id: result.id,status: result.status,summary: result.summary,providerCalls: 0,incidentWrites: 0 };
  } catch (err) { await failCycleQuality({ prisma: db,qualityId: id,error: err.message,stage: 'stored-review-check' });throw err; }
}
