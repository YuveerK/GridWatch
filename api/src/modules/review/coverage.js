import { casesForPost, postInclude, postFingerprint } from './cases.js';
import { acceptedExtraction, readingFaultItems, checkPostDispositions } from '../processing/quality.js';
import { faultItems } from '../processing/processor.service.js';
import { detectSuspicious } from './review.service.js';

/** Compare old diagnostics and the unified projection over the same stored window. Never repairs or indexes. */
export async function compareReviewCoverage(db, { from, to } = {}) {
  const posts = await db.sourcePost.findMany({ where: { ...(from || to ? { publishedAt: { ...(from ? { gte: from } : {}),...(to ? { lt: to } : {}) } } : {}) },include: postInclude });
  const current = posts.flatMap((p) => casesForPost(p,null));
  const represented = (id,index) => current.some((c) => c.postId === id && (c.faultIndex == null || c.faultIndex === index));
  const missing = [];
  for (const p of posts) {
    for (const flag of p.reviewItems) if (flag.status === 'OPEN' && !flag.sampled && !represented(p.id,flag.faultIndex)) missing.push({ postId: p.id,faultIndex: flag.faultIndex,kind: 'review-flag' });
    const e = acceptedExtraction(p);
    if (e?.result) for (const item of readingFaultItems(p,e,faultItems)) {
      const problems = checkPostDispositions({ expectedIndices: [item.faultIndex],decisions: p.linkDecisions.filter((d) => d.faultIndex === item.faultIndex),outagePosts: p.outagePosts.filter((d) => d.faultIndex === item.faultIndex) }).problems;
      if (problems.length && !represented(p.id,item.faultIndex)) missing.push({ postId: p.id,faultIndex: item.faultIndex,kind: 'disposition',problems });
    }
    if (['NEEDS_REVIEW','PROCESSING_ERROR'].includes(p.processingStatus) && !current.some((c) => c.postId === p.id)) missing.push({ postId: p.id,kind: 'processing-state' });
  }
  const suspected = await detectSuspicious({ prisma: db,postIds: posts.map((p) => p.id) });
  const unindexedFindings = suspected.filter((s) => {
    if (represented(s.postId,s.faultIndex)) return false;
    const p = posts.find((p) => p.id === s.postId);
    return !p.reviewItems.some((i) => i.faultIndex === s.faultIndex && i.status !== 'OPEN' && i.evidenceFingerprint === postFingerprint(p) && s.reasons.every((r) => i.reasons.some((old) => old.code === r.code)));
  });
  return { from: from?.toISOString() ?? null,to: to?.toISOString() ?? null,posts: posts.length,cases: current.length,missing,unindexedFindings,passed: !missing.length && !unindexedFindings.length };
}
