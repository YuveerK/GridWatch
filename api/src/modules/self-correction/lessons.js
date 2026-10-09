import { prisma as defaultPrisma } from '../../db/prisma.js';

// Reviewed, reusable knowledge (docs/CLAUDE_SELF_CORRECTING_ENGINE_IMPLEMENTATION.md §12). Scope-filter BEFORE any
// similarity ranking: service, municipality, source/asset scope and temporal validity. A lesson never changes an
// incident or graph identity by itself - it is constrained evidence fed to existing decision logic.

/**
 * Lessons whose scope covers this subject, as of `asOf` (chronological replay must never see a lesson that becomes
 * effective later, or one revoked/expired by then). Only ACTIVE lessons are ever applied automatically; CANDIDATE/
 * REVIEWED lessons are visible to an operator inspecting a proposal but never feed a decision.
 */
export async function applicableLessons({ prisma = defaultPrisma, serviceType, municipalityId = null, sourceAccount = null, asOf = new Date() } = {}) {
  const rows = await prisma.correctionLesson.findMany({
    where: {
      status: 'ACTIVE',
      serviceType,
      effectiveAt: { lte: asOf },
      OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
      AND: [
        { OR: [{ municipalityId: null }, { municipalityId }] },
        { OR: [{ sourceAccountScope: null }, { sourceAccountScope: sourceAccount }] },
      ],
    },
    orderBy: { effectiveAt: 'asc' },
  });
  return rows;
}

/**
 * Conflicting active lessons (opposite claims about the same kind of question) must not be silently resolved by
 * recency or count - abstain and record the conflict (§12). `sameQuestion` compares each pair's applicabilityPredicate.
 */
export function findLessonConflicts(lessons) {
  const conflicts = [];
  for (let i = 0; i < lessons.length; i += 1) {
    for (let j = i + 1; j < lessons.length; j += 1) {
      const a = lessons[i];
      const b = lessons[j];
      if (a.kind !== b.kind) continue;
      const sameQuestion = JSON.stringify(a.applicabilityPredicate) === JSON.stringify(b.applicabilityPredicate);
      const oppositeClaim = sameQuestion && JSON.stringify(a.claim) !== JSON.stringify(b.claim);
      if (oppositeClaim) conflicts.push({ a: a.id, b: b.id, kind: a.kind });
    }
  }
  return conflicts;
}

const overrideProvenance = (o) => `link-override:${o.postId}:${o.faultIndex}`;

/**
 * Import existing human corrections (LinkOverride rows - the real decision source of truth; tests/golden/
 * corrections.json is a derived export of these) as CANDIDATE lessons, with source provenance and a reason.
 * Idempotent on the override's own identity. Deliberately conservative: the imported applicabilityPredicate is
 * scoped to the EXACT source post/fault - a free-text override note cannot be auto-generalised into a broad rule
 * (§3). Generalising the predicate so the lesson covers a wider class of later cases is an explicit, separate
 * operator edit, made only when promoting CANDIDATE -> REVIEWED -> ACTIVE.
 */
export async function importExistingCorrections({ prisma = defaultPrisma, dryRun = true, now = new Date() } = {}) {
  const overrides = await prisma.linkOverride.findMany({
    include: { post: { select: { serviceType: true, sourceAccount: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const created = [];
  const skipped = [];
  for (const o of overrides) {
    if (!o.post) continue; // the source post no longer exists: nothing to found a lesson on
    const provenance = overrideProvenance(o);
    const existing = await prisma.correctionLesson.findFirst({ where: { establishedBy: provenance }, select: { id: true } });
    if (existing) {
      skipped.push(existing.id);
      continue;
    }
    if (dryRun) {
      created.push({ preview: true, kind: o.action === 'JOIN' ? 'INCIDENT_CONTINUATION' : 'INCIDENT_SEPARATION', postId: o.postId, faultIndex: o.faultIndex, note: o.note });
      continue;
    }
    const account = await prisma.sourceAccount.findFirst({ where: { displayName: o.post.sourceAccount }, select: { municipalityId: true } });
    const supports = [{ postId: o.postId, faultIndex: o.faultIndex, role: 'SUPPORT' }];
    if (o.action === 'JOIN' && o.anchorPostId) supports.push({ postId: o.anchorPostId, faultIndex: o.anchorFaultIndex, role: 'SUPPORT' });
    if (o.contrastPostId) supports.push({ postId: o.contrastPostId, faultIndex: 0, role: 'CONTRADICT' });
    const lesson = await prisma.correctionLesson.create({
      data: {
        kind: o.action === 'JOIN' ? 'INCIDENT_CONTINUATION' : 'INCIDENT_SEPARATION',
        status: 'CANDIDATE',
        serviceType: o.post.serviceType,
        municipalityId: account?.municipalityId ?? null,
        sourceAccountScope: o.post.sourceAccount,
        claim: { action: o.action, note: o.note },
        applicabilityPredicate: { sourcePostId: o.postId, sourceFaultIndex: o.faultIndex },
        exclusions: [],
        establishedBy: provenance,
        independentSupportCount: 1,
        effectiveAt: now,
        supports: { create: supports },
      },
    });
    created.push(lesson);
  }
  return { created, skipped, total: overrides.length };
}

/**
 * Promotion is always an explicit operator action, never automatic (§3, §12): an automatically repaired case does
 * not promote itself. `reason` is required moving to SUSPENDED/RETIRED so the revocation is explainable later.
 */
export async function setLessonStatus({ prisma = defaultPrisma, id, status, reason = null, now = new Date() }) {
  const valid = ['CANDIDATE', 'REVIEWED', 'ACTIVE', 'SUSPENDED', 'RETIRED'];
  if (!valid.includes(status)) throw new Error(`unknown lesson status: ${status}`);
  if ((status === 'SUSPENDED' || status === 'RETIRED') && !reason) throw new Error(`${status} requires a reason`);
  return prisma.correctionLesson.update({
    where: { id },
    data: { status, reviewedAt: status === 'REVIEWED' || status === 'ACTIVE' ? now : undefined, revocationReason: status === 'SUSPENDED' || status === 'RETIRED' ? reason : null },
  });
}
