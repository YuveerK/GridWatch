import { prisma as defaultPrisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { generateAllProposals } from './proposals.js';
import { eligibilityOf, checkInvariants, parseAllowlist } from './policies.js';
import { ActionPayload, EvidenceEnvelope } from './contracts.js';

// Bounded selection/orchestration for the CLI and the (future, off-by-default) cycle stage. This module owns
// PERSISTENCE; proposals.js only ever returns unpersisted drafts, so `--preview` can call it directly with none
// of this file's side effects.

function toRow(draft, eligibility, status) {
  return {
    postId: draft.postId,
    faultIndex: draft.faultIndex,
    serviceType: draft.serviceType,
    municipalityId: draft.municipalityId,
    sourceAccount: draft.sourceAccount,
    action: draft.action.type,
    generatorName: draft.generatorName,
    generatorVersion: draft.generatorVersion,
    policyName: draft.policyName,
    policyVersion: draft.policyVersion,
    triggerFamily: draft.triggerFamily,
    sourceContentHash: draft.fingerprints.sourceContentHash,
    sourceLayoutHash: draft.fingerprints.sourceLayoutHash,
    lessonSetFingerprint: draft.fingerprints.lessonSetFingerprint,
    candidateStateFingerprint: draft.fingerprints.candidateStateFingerprint,
    targetAnchorPostId: draft.action.anchorPostId ?? null,
    targetAnchorFaultIndex: draft.action.anchorFaultIndex ?? null,
    evidence: draft.evidence,
    expectedEffect: draft.expectedEffect,
    affectedManifest: { posts: draft.expectedEffect.postsAffected, outages: draft.expectedEffect.outageIdsAffected },
    beforePreview: draft.beforePreview,
    afterPreview: draft.afterPreview,
    eligibility,
    status,
    expiresAt: draft.expiresAt,
    idempotencyKey: draft.idempotencyKey,
  };
}

/**
 * Persist one draft as a RepairProposal, idempotently (the unique idempotencyKey means the same underlying
 * problem, evidence and policy version can never queue a second live proposal). Shadow mode may write this
 * record; it never alters a reading, incident, graph evidence, override, review resolution or notification.
 */
export async function persistProposal({ prisma = defaultPrisma, draft, mode = env.SELF_CORRECTION_MODE, allowlist = parseAllowlist() }) {
  ActionPayload.parse(draft.action); // never trust a generator's action shape, even our own, without validating it against the closed union
  EvidenceEnvelope.parse(draft.evidence);
  const invariantViolations = checkInvariants({ postServiceType: draft.serviceType, postMunicipalityId: draft.municipalityId });
  const eligibility = eligibilityOf({ policyName: draft.policyName, policyVersion: draft.policyVersion, mode, invariantViolations, allowlist });
  const status = mode === 'off' ? 'PROPOSED' : 'SHADOW_EVALUATED';
  const existing = await prisma.repairProposal.findUnique({ where: { idempotencyKey: draft.idempotencyKey } });
  if (existing) return { proposal: existing, created: false };
  const created = await prisma.repairProposal.create({ data: toRow(draft, eligibility, status) });
  return { proposal: created, created: true };
}

/** Read-only: generate proposal drafts without persisting anything. What `self-correct.js --preview` calls. */
export async function previewProposals({ prisma = defaultPrisma, postIds = null, service = null, limit = env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE, now = new Date() } = {}) {
  const scopedPostIds = postIds;
  const drafts = await generateAllProposals({ prisma, postIds: scopedPostIds, limit, now });
  return service ? drafts.filter((d) => d.serviceType === service) : drafts;
}

/**
 * Generate and persist proposals as shadow records. `off` mode does nothing at all (preserves current behaviour
 * exactly - no stage runs, no record written). `shadow`/`auto` both persist; only `auto` proposals may later be
 * applied (Phase 2's executor), and only when also allowlisted and gated.
 */
export async function runShadow({ prisma = defaultPrisma, postIds = null, limit = env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE, mode = env.SELF_CORRECTION_MODE, now = new Date() } = {}) {
  if (mode === 'off') return { generated: 0, persisted: 0, proposals: [] };
  const drafts = await generateAllProposals({ prisma, postIds, limit, now });
  const results = [];
  for (const draft of drafts) results.push(await persistProposal({ prisma, draft, mode }));
  return { generated: drafts.length, persisted: results.filter((r) => r.created).length, skipped: results.filter((r) => !r.created).length, proposals: results.map((r) => r.proposal) };
}

/**
 * The bounded cycle stage (wired into cycle.js, off by default). Never throws into the cycle - a failure here is
 * reported the same way every other optional stage is, and the cycle continues.
 */
export async function runSelfCorrectionStage({ ctx, prisma = defaultPrisma, mode = env.SELF_CORRECTION_MODE, startedAt = new Date() } = {}) {
  if (mode === 'off') return { ran: false, generated: 0, persisted: 0, applied: 0 };
  const budgetMs = env.SELF_CORRECTION_CYCLE_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const shadow = await runShadow({ prisma, limit: env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE, mode, now: startedAt });
  const timedOut = Date.now() > deadline;
  // Phase 2 adds bounded application here (SELF_CORRECTION_MAX_APPLIES_PER_CYCLE), gated on mode === 'auto'.
  return { ran: true, generated: shadow.generated, persisted: shadow.persisted, applied: 0, timedOut };
}
