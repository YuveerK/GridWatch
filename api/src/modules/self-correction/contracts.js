import { z } from 'zod';

// Strict, typed contracts for the self-correction engine (docs/CLAUDE_SELF_CORRECTING_ENGINE_IMPLEMENTATION.md §8-11).
// A model never picks a database field, SQL, file path or arbitrary action here: every payload below is validated
// against one of these closed shapes before it is trusted, whatever generated it.

export const RepairAction = z.enum(['REPROCESS_STORED', 'JOIN_FAULT', 'SPLIT_FAULT', 'PROPOSE_READING_REVISION', 'PROPOSE_LESSON']);

export const RepairProposalStatus = z.enum([
  'PROPOSED', 'SHADOW_EVALUATED', 'VERIFYING', 'ELIGIBLE', 'NEEDS_REVIEW', 'REJECTED', 'DEFERRED',
  'APPLYING', 'APPLIED', 'ROLLED_BACK', 'RECOVERY_REQUIRED', 'SUPERSEDED', 'EXPIRED',
]);

export const LessonKind = z.enum(['INCIDENT_CONTINUATION', 'INCIDENT_SEPARATION', 'EQUIPMENT_ALIAS', 'LOCALITY_CONTEXT', 'PLANNED_RESCHEDULE', 'READING_PATTERN']);
export const LessonStatus = z.enum(['CANDIDATE', 'REVIEWED', 'ACTIVE', 'SUSPENDED', 'RETIRED']);

const subject = { postId: z.string().min(1), faultIndex: z.number().int().min(0) };

/** The action union. Each variant carries exactly what its executor needs and nothing else - no free-form patch. */
export const ActionPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REPROCESS_STORED'), ...subject }),
  z.object({ type: z.literal('JOIN_FAULT'), ...subject, anchorPostId: z.string().min(1), anchorFaultIndex: z.number().int().min(0).default(0) }),
  z.object({ type: z.literal('SPLIT_FAULT'), ...subject, contrastPostId: z.string().min(1).nullable().default(null) }),
  z.object({ type: z.literal('PROPOSE_READING_REVISION'), ...subject, proposedResult: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('PROPOSE_LESSON'), ...subject, lessonDraft: z.record(z.string(), z.unknown()) }),
]);

/** One item of evidence the proposal rests on: an exact quote or fact, where it came from, and what it establishes. */
export const EvidenceRef = z.object({
  kind: z.enum(['QUOTE', 'READING_FIELD', 'CANDIDATE_STATE', 'OVERRIDE', 'DIRECTIVE', 'LESSON', 'DISPOSITION_CHECK']),
  postId: z.string().optional(),
  faultIndex: z.number().int().optional(),
  detail: z.string().min(1),
});

export const EvidenceEnvelope = z.object({
  action: ActionPayload,
  supporting: z.array(EvidenceRef).default([]),
  rejectedAlternatives: z.array(EvidenceRef).default([]),
  disqualifying: z.array(EvidenceRef).default([]),
  uncertainty: z.string().nullable().default(null),
  fingerprints: z.object({
    sourceContentHash: z.string().min(1),
    sourceLayoutHash: z.string().min(1),
    lessonSetFingerprint: z.string().min(1),
    candidateStateFingerprint: z.string().min(1),
  }),
});

export const ExpectedEffect = z.object({
  summary: z.string().min(1),
  postsAffected: z.array(z.string()).min(1),
  outageIdsAffected: z.array(z.string()).default([]),
});

export const EligibilityExplanation = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string()).default([]),
  policyName: z.string().min(1),
  policyVersion: z.string().min(1),
  mode: z.enum(['off', 'shadow', 'auto']),
});

/** The verifier's structured verdict (§10). A quote merely appearing in the source is not itself proof; policies.js enforces the predicate. */
export const VerifierVerdict = z.object({
  verdict: z.enum(['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE']),
  evidenceQuote: z.string(),
  reason: z.string(),
  alternativesConsidered: z.array(z.string()).default([]),
});

// ───────────── lifecycle state machine (§11) ─────────────

const TERMINAL = new Set(['APPLIED', 'ROLLED_BACK', 'RECOVERY_REQUIRED', 'REJECTED', 'SUPERSEDED', 'EXPIRED']);

/** Explicit edges, plus every non-terminal state may always go to SUPERSEDED/EXPIRED ("any unapplied proposal -> ..."). */
const EDGES = {
  PROPOSED: ['SHADOW_EVALUATED', 'VERIFYING'],
  SHADOW_EVALUATED: ['VERIFYING'],
  VERIFYING: ['ELIGIBLE', 'NEEDS_REVIEW', 'REJECTED', 'DEFERRED'],
  NEEDS_REVIEW: ['VERIFYING'],
  DEFERRED: ['VERIFYING'],
  // ELIGIBLE -> NEEDS_REVIEW: the affected scope is discovered to exceed configured limits (§11 step 5) after
  // eligibility passed but before any mutation - a legitimate abstention, not an application outcome.
  ELIGIBLE: ['APPLYING', 'NEEDS_REVIEW'],
  APPLYING: ['APPLIED', 'ROLLED_BACK', 'RECOVERY_REQUIRED'],
};

export class IllegalTransitionError extends Error {
  constructor(from, to) {
    super(`illegal proposal transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Validate (and return) the next status, or throw. Pure - no I/O, no clock, so it is trivially unit-testable. */
export function transition(from, to) {
  RepairProposalStatus.parse(from);
  RepairProposalStatus.parse(to);
  const allowed = EDGES[from] ?? [];
  const alwaysAllowed = !TERMINAL.has(from) && (to === 'SUPERSEDED' || to === 'EXPIRED');
  if (!allowed.includes(to) && !alwaysAllowed) throw new IllegalTransitionError(from, to);
  return to;
}

export const isTerminal = (status) => TERMINAL.has(status);

/** Idempotency key: one hash of exactly the fields the spec names (subject, evidence fingerprint, policy version, action/target). */
export function idempotencyKeyOf({ postId, faultIndex, sourceContentHash, sourceLayoutHash, policyName, policyVersion, action }) {
  const target = action.type === 'JOIN_FAULT' ? `${action.anchorPostId}#${action.anchorFaultIndex}` : action.type === 'SPLIT_FAULT' ? `split:${action.contrastPostId ?? ''}` : action.type;
  return [postId, faultIndex, sourceContentHash, sourceLayoutHash, policyName, policyVersion, action.type, target].join('|');
}
