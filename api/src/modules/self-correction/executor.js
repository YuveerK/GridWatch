import { prisma as defaultPrisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { snapshotForPosts, restoreSnapshot } from '../processing/repair.js';
import { saveSnapshotFile } from '../processing/repair-files.js';
import { reprocessPost } from '../processing/processor.service.js';
import { faultItems } from '../processing/processor.service.js';
import { acceptedExtraction, checkPostDispositions, readingFaultItems } from '../processing/quality.js';
import { sweepStaleOutages } from '../outages/linker.service.js';
import { reconcileReviewItems } from '../review/review.service.js';
import { buildEvidenceEnvelope, fingerprintsChanged } from './evidence.js';
import { eligibilityOf, checkInvariants, parseAllowlist } from './policies.js';
import { transition } from './contracts.js';

// The lease-aware, staged, reversible repair executor (§11's numbered sequence). Never called with a database
// transaction already open around slow work; snapshot-then-mutate-then-postcondition-check-then-commit, with a
// restore on any failure. Every invariant/eligibility/lease/evidence/scope check is enforced here regardless of
// how applyProposal was invoked - an explicit operator --apply cannot mean bypassing them.

const TERMINAL_UNAPPLIED = new Set(['ROLLED_BACK', 'REJECTED', 'SUPERSEDED', 'EXPIRED', 'RECOVERY_REQUIRED']);

async function setStatus(prisma, id, from, to, extra = {}) {
  const next = transition(from, to);
  return prisma.repairProposal.update({ where: { id }, data: { status: next, ...extra } });
}

/** Idempotent move: a no-op (just an optional data update) if already at `to`, otherwise a validated transition
 * from the proposal's OWN current status - never a guessed "from", so a resumed/retried call is always safe. */
async function moveTo(prisma, proposal, to, extra = {}) {
  if (proposal.status === to) return Object.keys(extra).length ? prisma.repairProposal.update({ where: { id: proposal.id }, data: extra }) : proposal;
  return setStatus(prisma, proposal.id, proposal.status, to, extra);
}

/** §11 step 4: re-derive fresh evidence and compare fingerprints. A meaningful change supersedes the proposal. */
async function revalidate({ prisma, proposal }) {
  const envelope = await buildEvidenceEnvelope({ prisma, postId: proposal.postId, faultIndex: proposal.faultIndex });
  if (!envelope.fingerprints) return { ok: false, reason: 'no accepted reading any more for this post', envelope };
  const changed = fingerprintsChanged(
    { sourceContentHash: proposal.sourceContentHash, sourceLayoutHash: proposal.sourceLayoutHash, candidateStateFingerprint: proposal.candidateStateFingerprint, lessonSetFingerprint: proposal.lessonSetFingerprint },
    envelope.fingerprints,
  );
  if (changed) return { ok: false, reason: 'evidence (reading, layout, candidates or lessons) changed since this proposal was generated', envelope };
  if (envelope.override) return { ok: false, reason: 'a human override now exists for this subject: automatic action refused', envelope };
  return { ok: true, envelope };
}

/** Every action currently supported reduces to "reprocess from the stored reading" - JOIN/SPLIT act through an
 * AutoRepairDirective the linker checks with the same precedence as a human LinkOverride (never instead of one). */
async function applyAction(prisma, action, ctx) {
  if (action.type === 'REPROCESS_STORED' || action.type === 'JOIN_FAULT' || action.type === 'SPLIT_FAULT') {
    return reprocessPost(action.postId, { ctx, reextract: false });
  }
  throw new Error(`action ${action.type} is proposal/review only in this release: it cannot be applied automatically`);
}

/** §11 mandatory postconditions this executor can check deterministically. Structural checks cannot prove the
 * semantic proposal correct - they are necessary IN ADDITION to the evidence verification already done, not a replacement. */
async function checkPostconditions({ prisma, postIds, priorOverrides }) {
  const problems = [];
  const posts = await prisma.sourcePost.findMany({ where: { id: { in: postIds } }, include: { readingOverride: true, PostMedia: true, extractions: true, linkDecisions: true, outagePosts: true } });
  for (const post of posts) {
    const extraction = acceptedExtraction(post);
    if (!extraction?.result) continue;
    const items = readingFaultItems(post, extraction, faultItems);
    const verdict = checkPostDispositions({ expectedIndices: items.map((i) => i.faultIndex), decisions: post.linkDecisions, outagePosts: post.outagePosts });
    for (const p of verdict.problems) problems.push(`${post.externalId}: ${p}`);
    const outageIds = [...new Set(post.outagePosts.map((o) => o.outageId))];
    if (outageIds.length) {
      const outages = await prisma.outage.findMany({ where: { id: { in: outageIds } }, select: { serviceType: true, municipalityId: true } });
      for (const o of outages) {
        if (o.serviceType !== post.serviceType) problems.push(`${post.externalId}: linked to an outage of a different service (${o.serviceType})`);
        if (post.municipalityId != null && o.municipalityId != null && post.municipalityId !== o.municipalityId) problems.push(`${post.externalId}: linked to an outage of a different municipality`);
      }
    }
  }
  const overridesNow = await prisma.linkOverride.findMany({ where: { postId: { in: postIds } } });
  for (const before of priorOverrides) {
    const now = overridesNow.find((o) => o.postId === before.postId && o.faultIndex === before.faultIndex);
    if (!now || now.action !== before.action || now.anchorPostId !== before.anchorPostId || now.anchorFaultIndex !== before.anchorFaultIndex) {
      problems.push(`a human LinkOverride on ${before.postId}#${before.faultIndex} was changed or removed`);
    }
  }
  return problems;
}

/**
 * Apply one proposal end-to-end. `ctx` is the held pipeline lease (withLease(PIPELINE, ...)). Idempotent: an
 * already-APPLIED proposal returns APPLIED without doing anything; a terminal-unapplied proposal is refused.
 */
export async function applyProposal({ prisma = defaultPrisma, proposalId, ctx, allowlist = parseAllowlist(), mode = env.SELF_CORRECTION_MODE }) {
  ctx?.assertHeld();
  let proposal = await prisma.repairProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) return { outcome: 'REJECTED', reason: 'no such proposal' };
  if (proposal.status === 'APPLIED') return { outcome: 'APPLIED', reason: 'already applied (idempotent)', proposalId };
  if (TERMINAL_UNAPPLIED.has(proposal.status)) return { outcome: proposal.status, reason: `proposal is terminal (${proposal.status})` };
  if (proposal.status === 'APPLYING') return { outcome: 'RECOVERY_REQUIRED', reason: 'this proposal is mid-application (a prior attempt may have crashed): use --recover on its latest attempt, not --apply again' };
  if (proposal.expiresAt < new Date()) {
    proposal = await moveTo(prisma, proposal, 'EXPIRED', { terminalReason: 'proposal TTL passed' });
    return { outcome: 'EXPIRED', reason: 'proposal TTL passed' };
  }
  if (proposal.attemptCount >= env.SELF_CORRECTION_MAX_ATTEMPTS) {
    proposal = await moveTo(prisma, proposal, 'VERIFYING');
    proposal = await moveTo(prisma, proposal, 'NEEDS_REVIEW', { terminalReason: `max attempts (${env.SELF_CORRECTION_MAX_ATTEMPTS}) reached` });
    return { outcome: 'NEEDS_REVIEW', reason: `max attempts (${env.SELF_CORRECTION_MAX_ATTEMPTS}) reached` };
  }
  if (!['REPROCESS_STORED', 'JOIN_FAULT', 'SPLIT_FAULT'].includes(proposal.action)) {
    proposal = await moveTo(prisma, proposal, 'VERIFYING');
    proposal = await moveTo(prisma, proposal, 'REJECTED', { terminalReason: `${proposal.action} is proposal/review only in this release` });
    return { outcome: 'REJECTED', reason: `${proposal.action} is proposal/review only in this release` };
  }

  const revalidation = await revalidate({ prisma, proposal });
  if (!revalidation.ok) {
    proposal = await moveTo(prisma, proposal, 'SUPERSEDED', { terminalReason: revalidation.reason });
    return { outcome: 'SUPERSEDED', reason: revalidation.reason };
  }

  proposal = await moveTo(prisma, proposal, 'VERIFYING');
  // for JOIN_FAULT, the target is the anchor post's own service/municipality - a candidate from another service
  // or municipality is excluded here, BEFORE application, never merely penalised (§4 invariant 1 and 2)
  let targetServiceType = null;
  let targetMunicipalityId = null;
  if (proposal.action === 'JOIN_FAULT' && proposal.targetAnchorPostId) {
    const anchor = await prisma.sourcePost.findUnique({ where: { id: proposal.targetAnchorPostId }, select: { serviceType: true, sourceAccount: true } });
    targetServiceType = anchor?.serviceType ?? null;
    const anchorAccount = anchor ? await prisma.sourceAccount.findFirst({ where: { displayName: anchor.sourceAccount }, select: { municipalityId: true } }) : null;
    targetMunicipalityId = anchorAccount?.municipalityId ?? null;
  }
  const invariantViolations = checkInvariants({ postServiceType: proposal.serviceType, targetServiceType, postMunicipalityId: proposal.municipalityId, targetMunicipalityId, hasHumanOverride: Boolean(revalidation.envelope.override) });
  const eligibility = eligibilityOf({ policyName: proposal.policyName, policyVersion: proposal.policyVersion, mode, invariantViolations, allowlist });
  proposal = await prisma.repairProposal.update({ where: { id: proposal.id }, data: { eligibility } });
  if (!eligibility.eligible) {
    proposal = await moveTo(prisma, proposal, 'REJECTED', { terminalReason: eligibility.reasons.join('; ') });
    return { outcome: 'REJECTED', reason: eligibility.reasons.join('; ') };
  }
  proposal = await moveTo(prisma, proposal, 'ELIGIBLE');

  const postsAffected = [...new Set(proposal.expectedEffect?.postsAffected ?? [proposal.postId])];
  const outagesAffected = [...new Set(proposal.expectedEffect?.outageIdsAffected ?? [])];
  if (postsAffected.length > env.SELF_CORRECTION_MAX_POSTS_PER_REPAIR || outagesAffected.length > env.SELF_CORRECTION_MAX_OUTAGES_PER_REPAIR) {
    proposal = await moveTo(prisma, proposal, 'NEEDS_REVIEW', { terminalReason: 'affected scope exceeds SELF_CORRECTION_MAX_POSTS_PER_REPAIR/SELF_CORRECTION_MAX_OUTAGES_PER_REPAIR' });
    return { outcome: 'NEEDS_REVIEW', reason: 'affected scope exceeds configured limits' };
  }

  proposal = await moveTo(prisma, proposal, 'APPLYING');
  const attemptNumber = proposal.attemptCount + 1;
  const startedAt = new Date();
  const affectedManifest = { posts: postsAffected, outages: outagesAffected };
  const priorOverrides = await prisma.linkOverride.findMany({ where: { postId: { in: postsAffected } } });

  let snapshot;
  let snapshotFile;
  try {
    snapshot = await snapshotForPosts(prisma, postsAffected, startedAt);
    snapshotFile = saveSnapshotFile(snapshot, 'self-correct');
  } catch (err) {
    await prisma.repairAttempt.create({ data: { proposalId: proposal.id, attemptNumber, workerOwner: ctx?.owner ?? 'unknown', operation: proposal.action, outcome: 'RECOVERY_REQUIRED', errorClass: 'SNAPSHOT_FAILED', inputFingerprint: proposal.sourceContentHash, affectedManifest, endedAt: new Date(), validation: { error: String(err.message).slice(0, 300) } } });
    await prisma.repairProposal.update({ where: { id: proposal.id }, data: { attemptCount: attemptNumber } });
    await setStatus(prisma, proposal.id, 'APPLYING', 'RECOVERY_REQUIRED', { terminalReason: `snapshot failed: ${err.message}` });
    return { outcome: 'RECOVERY_REQUIRED', reason: `snapshot failed before any mutation: ${err.message}` };
  }

  // an attempt row now exists BEFORE the mutation, so a directive it creates (JOIN/SPLIT) can reference it,
  // and a crash between here and the final update leaves a visible, recoverable trace rather than none
  const attempt = await prisma.repairAttempt.create({ data: { proposalId: proposal.id, attemptNumber, workerOwner: ctx?.owner ?? 'unknown', operation: proposal.action, outcome: 'RECOVERY_REQUIRED', inputFingerprint: proposal.sourceContentHash, affectedManifest, snapshotRef: snapshotFile } });

  const rollback = async (errorClass, detail) => {
    ctx?.assertHeld();
    if (proposal.action === 'JOIN_FAULT' || proposal.action === 'SPLIT_FAULT') {
      await prisma.autoRepairDirective.deleteMany({ where: { proposalId: proposal.id } });
    }
    await restoreSnapshot({ prisma, snapshot, ctx });
    await reconcileReviewItems({ prisma, postIds: postsAffected });
    await sweepStaleOutages(new Date(), { ctx });
    await prisma.repairAttempt.update({ where: { id: attempt.id }, data: { outcome: 'ROLLED_BACK', errorClass, endedAt: new Date(), validation: { detail } } });
    await prisma.repairProposal.update({ where: { id: proposal.id }, data: { attemptCount: attemptNumber } });
    await setStatus(prisma, proposal.id, 'APPLYING', 'ROLLED_BACK', { terminalReason: String(detail).slice(0, 300) });
    return { outcome: 'ROLLED_BACK', reason: detail };
  };

  let opResult;
  try {
    ctx?.assertHeld();
    if (proposal.action === 'JOIN_FAULT' || proposal.action === 'SPLIT_FAULT') {
      await prisma.autoRepairDirective.upsert({
        where: { postId_faultIndex: { postId: proposal.postId, faultIndex: proposal.faultIndex } },
        create: {
          postId: proposal.postId, faultIndex: proposal.faultIndex, proposalId: proposal.id, attemptId: attempt.id,
          action: proposal.action === 'JOIN_FAULT' ? 'JOIN' : 'SPLIT',
          targetAnchorPostId: proposal.targetAnchorPostId, targetAnchorFaultIndex: proposal.targetAnchorFaultIndex,
          policyName: proposal.policyName, policyVersion: proposal.policyVersion, evidenceFingerprint: proposal.sourceContentHash,
        },
        update: {
          proposalId: proposal.id, attemptId: attempt.id, action: proposal.action === 'JOIN_FAULT' ? 'JOIN' : 'SPLIT',
          targetAnchorPostId: proposal.targetAnchorPostId, targetAnchorFaultIndex: proposal.targetAnchorFaultIndex,
          status: 'ACTIVE', invalidationReason: null,
        },
      });
    }
    opResult = await applyAction(prisma, { type: proposal.action, postId: proposal.postId, faultIndex: proposal.faultIndex, anchorPostId: proposal.targetAnchorPostId, anchorFaultIndex: proposal.targetAnchorFaultIndex }, ctx);
    if (['ERROR', 'BUSY', 'NEEDS_REVIEW'].includes(opResult?.outcome)) throw new Error(`reprocess did not settle cleanly: ${opResult.outcome}${opResult.error ? ` (${opResult.error})` : ''}`);
  } catch (err) {
    return await rollback(err.name ?? 'APPLY_FAILED', String(err.message).slice(0, 300));
  }

  const problems = await checkPostconditions({ prisma, postIds: postsAffected, priorOverrides });
  if (problems.length) return await rollback('POSTCONDITION_FAILED', problems.join('; '));

  // commit success and reconcile reviews only now that the asserted problem is actually confirmed removed
  await reconcileReviewItems({ prisma, postIds: postsAffected });
  await sweepStaleOutages(new Date(), { ctx });
  await prisma.repairAttempt.update({ where: { id: attempt.id }, data: { outcome: 'APPLIED', endedAt: new Date(), afterSignature: JSON.stringify(opResult).slice(0, 500), validation: { problems: [] } } });
  await prisma.repairProposal.update({ where: { id: proposal.id }, data: { attemptCount: attemptNumber } });
  await setStatus(prisma, proposal.id, 'APPLYING', 'APPLIED', { afterPreview: { predicted: false, result: opResult } });

  return { outcome: 'APPLIED', proposalId: proposal.id, attemptId: attempt.id, result: opResult, snapshot: snapshotFile };
}

/**
 * Operator-invoked recovery for a RECOVERY_REQUIRED attempt (§11: "mark RECOVERY_REQUIRED, prevent further automatic
 * work on that scope and surface an operator-visible incident" - this is that surfaced recovery path). Never restores
 * a stale snapshot over a newer human or scheduler change: it re-checks the same idempotent signature restoreSnapshot
 * already uses before writing anything.
 */
export async function recoverAttempt({ prisma = defaultPrisma, attemptId, ctx }) {
  ctx?.assertHeld();
  const attempt = await prisma.repairAttempt.findUnique({ where: { id: attemptId }, include: { proposal: true } });
  if (!attempt) return { outcome: 'FAILED', reason: 'no such attempt' };
  if (attempt.outcome === 'APPLIED') return { outcome: 'ALREADY_APPLIED', reason: 'this attempt already succeeded; nothing to recover' };
  if (!attempt.snapshotRef) return { outcome: 'FAILED', reason: 'no snapshot was recorded for this attempt: cannot safely recover' };
  const { loadSnapshotFile } = await import('../processing/repair-files.js');
  const snapshot = loadSnapshotFile(attempt.snapshotRef);
  if (attempt.proposal.action === 'JOIN_FAULT' || attempt.proposal.action === 'SPLIT_FAULT') {
    await prisma.autoRepairDirective.deleteMany({ where: { proposalId: attempt.proposalId } });
  }
  const result = await restoreSnapshot({ prisma, snapshot, ctx });
  const postIds = snapshot.postIds;
  await reconcileReviewItems({ prisma, postIds });
  await sweepStaleOutages(new Date(), { ctx });
  await prisma.repairAttempt.update({ where: { id: attemptId }, data: { outcome: 'ROLLED_BACK', recoveryOutcome: 'RECOVERED', endedAt: new Date() } });
  const proposal = await prisma.repairProposal.findUnique({ where: { id: attempt.proposalId } });
  if (proposal && proposal.status !== 'ROLLED_BACK') await setStatus(prisma, proposal.id, proposal.status, 'ROLLED_BACK', { terminalReason: 'recovered by operator' });
  return { outcome: 'RECOVERED', restored: result };
}
