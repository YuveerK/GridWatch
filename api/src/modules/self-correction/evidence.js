import { createHash } from 'node:crypto';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { readingRevision } from '../../lib/reading-revision.js';
import { acceptedExtraction, readingFaultItems } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { loadCandidates } from '../outages/linker.service.js';
import { overrideFor } from '../outages/overrides.js';
import { applicableLessons } from './lessons.js';

const hash = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);

/** Everything that can change what the engine did to this reading. Reuses lib/reading-revision.js exactly. */
export const sourceContentHash = (result) => readingRevision(result) ?? hash('no-result');

/** The fault layout shape only (indices + relevance) - separate from content, per invariant 6 ("layout changes must invalidate affected proposals"). */
export const sourceLayoutHash = (extraction, items) => hash({ relevance: extraction.relevance, indices: items.map((i) => i.faultIndex) });

/** Which outages this post could link to, and at what score - order-independent, id-scoped by stableId so a rebuild's fresh ids don't matter. */
export const candidateStateFingerprint = (candidates) =>
  hash(candidates.map((c) => ({ id: c.stableId, score: Math.round((c.score ?? 0) * 1000) })).sort((a, b) => String(a.id).localeCompare(String(b.id))));

/** Which reviewed lessons were in force, and at what version - so a later lesson revision or new conflict invalidates a stale proposal. */
export const lessonSetFingerprint = (lessons) => hash(lessons.map((l) => `${l.id}@${l.version}`).sort());

/**
 * The fault-specific evidence envelope (§10): the accepted reading and this one fault, candidate episodes, existing
 * human/automatic decisions, applicable lessons, and the fingerprints a later revalidation compares against. Never
 * the whole contents of a multi-fault graphic - only what this fault itself says.
 */
export async function buildEvidenceEnvelope({ prisma = defaultPrisma, postId, faultIndex }) {
  const post = await prisma.sourcePost.findUniqueOrThrow({
    where: { id: postId },
    select: { id: true, externalId: true, text: true, noteTweetText: true, publishedAt: true, serviceType: true, sourceAccount: true, extractions: true, readingOverride: true, PostMedia: true, linkDecisions: true, outagePosts: true },
  });
  const extraction = acceptedExtraction(post);
  if (!extraction?.result) return { post, extraction: null, item: null, candidates: [], override: null, directive: null, lessons: [], fingerprints: null };

  const items = readingFaultItems(post, extraction, faultItems);
  const item = items.find((i) => i.faultIndex === faultIndex) ?? null;

  const account = await prisma.sourceAccount.findFirst({ where: { displayName: post.sourceAccount }, select: { municipalityId: true } });
  const municipalityId = account?.municipalityId ?? null;

  const override = await overrideFor(postId, faultIndex, prisma);
  const directive = await prisma.autoRepairDirective.findUnique({ where: { postId_faultIndex: { postId, faultIndex } } });
  const lessons = item ? await applicableLessons({ prisma, serviceType: post.serviceType, municipalityId, sourceAccount: post.sourceAccount, asOf: post.publishedAt }) : [];

  let candidates = [];
  if (item) {
    const text = post.noteTweetText || post.text;
    const candidatePost = { id: post.id, postedAt: post.publishedAt, serviceType: post.serviceType, municipalityId, text };
    candidates = await loadCandidates(candidatePost).catch(() => []);
  }

  const fingerprints = {
    sourceContentHash: sourceContentHash(extraction.result),
    sourceLayoutHash: sourceLayoutHash(extraction, items),
    candidateStateFingerprint: candidateStateFingerprint(candidates),
    lessonSetFingerprint: lessonSetFingerprint(lessons),
  };

  return { post, extraction, item, items, candidates, override, directive, lessons, municipalityId, fingerprints };
}

/** Has anything this proposal depends on actually changed since it was built? A meaningful change supersedes it (§11 step 4). */
export function fingerprintsChanged(stored, fresh) {
  if (!fresh) return true;
  return stored.sourceContentHash !== fresh.sourceContentHash || stored.sourceLayoutHash !== fresh.sourceLayoutHash || stored.candidateStateFingerprint !== fresh.candidateStateFingerprint || stored.lessonSetFingerprint !== fresh.lessonSetFingerprint;
}
