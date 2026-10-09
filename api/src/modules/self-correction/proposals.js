import { env } from '../../config/env.js';
import { acceptedExtraction, checkPostDispositions, readingFaultItems } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { quotedStatusId, singleQuotedOutage } from '../outages/linker.service.js';
import { overrideFor } from '../outages/overrides.js';
import { idempotencyKeyOf } from './contracts.js';
import { buildEvidenceEnvelope } from './evidence.js';

// Deterministic repair candidates (§9): no model call. Each generator finds a specific, narrow, well-understood
// pipeline defect and returns an unpersisted proposal DRAFT - policies.js decides eligibility, service.js persists
// it. "Deterministic" describes the DETECTOR: whether the repair may ever auto-apply is a separate, later gate.

export const POLICY_DISPOSITION_REPAIR = { name: 'disposition-layout-repair', version: '1' };
export const POLICY_QUOTE_RESTORATION = { name: 'quote-restoration', version: '1' };

const isCustomerReply = (post) => /^\s*@\w+/.test(post.noteTweetText || post.text || '');
const HOUR = 3_600_000;

/**
 * Disposition/layout inconsistency: the current accepted reading and the stored dispositions/timeline disagree
 * (an obsolete fault index, a missing disposition, a mismatched timeline entry). Exactly the mechanism
 * `scripts/reconcile-dispositions.js` already repairs by hand; this generator only detects and describes it.
 */
export async function findDispositionInconsistencies({ prisma, postIds = null, limit = 50 }) {
  const posts = await prisma.sourcePost.findMany({
    where: postIds ? { id: { in: postIds } } : {},
    orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
    include: { readingOverride: true, PostMedia: true, extractions: true, linkDecisions: true, outagePosts: true },
    take: postIds ? undefined : limit * 4,
  });
  const out = [];
  for (const post of posts) {
    if (isCustomerReply(post)) continue;
    const extraction = acceptedExtraction(post);
    if (!extraction?.result) continue;
    const items = readingFaultItems(post, extraction, faultItems);
    const verdict = checkPostDispositions({ expectedIndices: items.map((i) => i.faultIndex), decisions: post.linkDecisions, outagePosts: post.outagePosts });
    if (verdict.problems.length) out.push({ post, extraction, items, problems: verdict.problems });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A NEEDS_REVIEW (or unresolved) restoration that names no equipment or suburb, but quotes exactly one earlier post
 * of its own account/service that resolves to a single, still-compatible outage. Reprocessing links it through
 * `linkPost`'s existing quoted-restoration rule (linker.service.js) - this generator only detects the opportunity.
 */
export async function findQuoteRestorationCandidates({ prisma, postIds = null, limit = 50 }) {
  const posts = await prisma.sourcePost.findMany({
    where: {
      ...(postIds ? { id: { in: postIds } } : {}),
      linkDecisions: { some: { outcome: { in: ['NEEDS_REVIEW', 'NEW'] } } },
    },
    orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
    include: { readingOverride: true, PostMedia: true, extractions: true, linkDecisions: true },
    take: postIds ? undefined : limit * 6,
  });
  const out = [];
  for (const post of posts) {
    if (isCustomerReply(post)) continue;
    const extraction = acceptedExtraction(post);
    if (!extraction?.result || extraction.relevance !== 'RESTORATION') continue;
    if ((extraction.result.entities?.length ?? 0) || (extraction.result.localities?.length ?? 0)) continue;
    const unresolved = post.linkDecisions.find((d) => d.faultIndex === 0 && ['NEEDS_REVIEW', 'NEW'].includes(d.outcome) && !d.outageId);
    if (!unresolved) continue;
    const quotedId = quotedStatusId(post.rawPayload);
    if (!quotedId) continue;
    const quoted = await prisma.sourcePost.findFirst({
      where: { externalId: quotedId, sourceAccount: post.sourceAccount, serviceType: post.serviceType },
      select: { externalId: true, publishedAt: true, outagePosts: { select: { outageId: true, outage: { select: { serviceType: true, status: true, lastUpdateAt: true } } } } },
    });
    if (!quoted) continue;
    const quotedOutageId = singleQuotedOutage(
      quoted.outagePosts
        .filter((p) => p.outage.serviceType === post.serviceType && (p.outage.status !== 'CLOSED' || (post.publishedAt >= quoted.publishedAt && post.publishedAt <= new Date(p.outage.lastUpdateAt.getTime() + env.OUTAGE_WINDOW_HOURS * HOUR))))
        .map((p) => p.outageId),
    );
    if (!quotedOutageId) continue;
    out.push({ post, extraction, quotedExternalId: quoted.externalId, quotedOutageId });
    if (out.length >= limit) break;
  }
  return out;
}

/** Turn a disposition-inconsistency finding into a REPROCESS_STORED proposal draft (not yet persisted). */
export async function draftDispositionRepairProposal({ prisma, post, problems, now = new Date() }) {
  const faultIndex = 0; // the repair is whole-post (reprocessPost); the affected fault indices are recorded in evidence
  if (await overrideFor(post.id, faultIndex, prisma)) return null; // a human decision on this subject: never an automatic candidate
  const envelope = await buildEvidenceEnvelope({ prisma, postId: post.id, faultIndex });
  if (!envelope.fingerprints) return null;
  const account = await prisma.sourceAccount.findFirst({ where: { displayName: post.sourceAccount }, select: { municipalityId: true } });
  const action = { type: 'REPROCESS_STORED', postId: post.id, faultIndex };
  return {
    postId: post.id,
    faultIndex,
    serviceType: post.serviceType,
    municipalityId: account?.municipalityId ?? null,
    sourceAccount: post.sourceAccount,
    action,
    generatorName: 'findDispositionInconsistencies',
    generatorVersion: '1',
    policyName: POLICY_DISPOSITION_REPAIR.name,
    policyVersion: POLICY_DISPOSITION_REPAIR.version,
    triggerFamily: 'disposition-layout-inconsistency',
    fingerprints: envelope.fingerprints,
    evidence: {
      action,
      supporting: problems.map((p) => ({ kind: 'DISPOSITION_CHECK', postId: post.id, detail: p })),
      rejectedAlternatives: [],
      disqualifying: [],
      uncertainty: null,
      fingerprints: envelope.fingerprints,
    },
    expectedEffect: {
      summary: `reprocess ${post.externalId} from its stored, accepted reading so every expected fault has exactly one disposition matching the current reading`,
      postsAffected: [post.id],
      outageIdsAffected: [...new Set(post.outagePosts?.map((o) => o.outageId) ?? [])],
    },
    beforePreview: { problems, dispositions: post.linkDecisions?.map((d) => ({ faultIndex: d.faultIndex, outcome: d.outcome, outageId: d.outageId })) ?? [] },
    afterPreview: { predicted: true, summary: 'each currently expected fault index will have exactly one disposition consistent with the current reading; obsolete indices will be removed. The exact resulting outage is not claimed until the repair is actually applied.' },
    idempotencyKey: idempotencyKeyOf({ postId: post.id, faultIndex, sourceContentHash: envelope.fingerprints.sourceContentHash, sourceLayoutHash: envelope.fingerprints.sourceLayoutHash, policyName: POLICY_DISPOSITION_REPAIR.name, policyVersion: POLICY_DISPOSITION_REPAIR.version, action }),
    expiresAt: new Date(now.getTime() + env.SELF_CORRECTION_PROPOSAL_TTL_MINUTES * 60_000),
  };
}

/** Turn a quote-restoration finding into a REPROCESS_STORED proposal draft (not yet persisted). */
export async function draftQuoteRestorationProposal({ prisma, post, quotedExternalId, quotedOutageId, now = new Date() }) {
  const faultIndex = 0;
  if (await overrideFor(post.id, faultIndex, prisma)) return null;
  const envelope = await buildEvidenceEnvelope({ prisma, postId: post.id, faultIndex });
  if (!envelope.fingerprints) return null;
  const account = await prisma.sourceAccount.findFirst({ where: { displayName: post.sourceAccount }, select: { municipalityId: true } });
  const action = { type: 'REPROCESS_STORED', postId: post.id, faultIndex };
  return {
    postId: post.id,
    faultIndex,
    serviceType: post.serviceType,
    municipalityId: account?.municipalityId ?? null,
    sourceAccount: post.sourceAccount,
    action,
    generatorName: 'findQuoteRestorationCandidates',
    generatorVersion: '1',
    policyName: POLICY_QUOTE_RESTORATION.name,
    policyVersion: POLICY_QUOTE_RESTORATION.version,
    triggerFamily: 'explicit-single-incident-quote-restoration',
    fingerprints: envelope.fingerprints,
    evidence: {
      action,
      supporting: [{ kind: 'QUOTE', postId: post.id, detail: `quotes exactly one prior post (${quotedExternalId}), which resolves to a single compatible outage` }],
      rejectedAlternatives: [],
      disqualifying: [],
      uncertainty: null,
      fingerprints: envelope.fingerprints,
    },
    expectedEffect: {
      summary: `reprocess ${post.externalId}: its quoted post ${quotedExternalId} names exactly one compatible outage, so the restoration should link there`,
      postsAffected: [post.id],
      outageIdsAffected: [quotedOutageId],
    },
    beforePreview: { outcome: 'NEEDS_REVIEW or NEW, no outage' },
    afterPreview: { predicted: true, summary: `expected to link to the outage of the quoted post ${quotedExternalId}, via the existing quoted-restoration rule` },
    idempotencyKey: idempotencyKeyOf({ postId: post.id, faultIndex, sourceContentHash: envelope.fingerprints.sourceContentHash, sourceLayoutHash: envelope.fingerprints.sourceLayoutHash, policyName: POLICY_QUOTE_RESTORATION.name, policyVersion: POLICY_QUOTE_RESTORATION.version, action }),
    expiresAt: new Date(now.getTime() + env.SELF_CORRECTION_PROPOSAL_TTL_MINUTES * 60_000),
  };
}

/** Run every deterministic generator, bounded. Returns unpersisted draft proposals (nulls filtered out). */
export async function generateAllProposals({ prisma, postIds = null, limit = env.SELF_CORRECTION_MAX_PROPOSALS_PER_CYCLE, now = new Date() }) {
  const drafts = [];
  const dispositionFindings = await findDispositionInconsistencies({ prisma, postIds, limit });
  for (const f of dispositionFindings) {
    if (drafts.length >= limit) break;
    const draft = await draftDispositionRepairProposal({ prisma, post: f.post, problems: f.problems, now });
    if (draft) drafts.push(draft);
  }
  if (drafts.length < limit) {
    const quoteFindings = await findQuoteRestorationCandidates({ prisma, postIds, limit: limit - drafts.length });
    for (const f of quoteFindings) {
      if (drafts.length >= limit) break;
      const draft = await draftQuoteRestorationProposal({ prisma, post: f.post, quotedExternalId: f.quotedExternalId, quotedOutageId: f.quotedOutageId, now });
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}
