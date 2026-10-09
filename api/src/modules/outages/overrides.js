import { prisma } from '../../db/prisma.js';

/**
 * A person's correction of where one post (fault) belongs. Stored per post, so a rebuild applies it again.
 *   SPLIT: the post opens its own outage.
 *   JOIN:  the post joins whatever outage the anchor post is in (a post, not an outage id: outage ids change on a rebuild).
 */
export async function overrideFor(postId, faultIndex, db = prisma) {
  return db.linkOverride.findUnique({ where: { postId_faultIndex: { postId, faultIndex } } });
}

/**
 * What the override says to do now: { action: 'SPLIT' } | { action: 'JOIN', outageId } | null.
 * A JOIN whose anchor is not linked yet blocks this fault until the anchor is available.
 */
export async function resolveOverride(postId, faultIndex, db = prisma) {
  const o = await overrideFor(postId, faultIndex, db);
  if (!o) return null;
  if (o.action === 'SPLIT') return { action: 'SPLIT', note: o.note };
  try { await validateOverrideGraph([{ postId,faultIndex,...o }],db); }
  catch (err) { return { action: 'BLOCKED',note: err.message }; }
  const anchor = await db.outagePost.findFirst({ where: { postId: o.anchorPostId, faultIndex: o.anchorFaultIndex }, select: { outageId: true } });
  return anchor ? { action: 'JOIN', outageId: anchor.outageId, note: o.note } : { action: 'BLOCKED', note: 'The human join anchor has not been linked yet.' };
}

export async function setOverride({ postId, faultIndex = 0, action, anchorPostId = null, anchorFaultIndex = 0, note = null, contrastPostId = null }) {
  if (action !== 'SPLIT' && action !== 'JOIN') throw new Error('action must be SPLIT or JOIN');
  if (action === 'JOIN' && !anchorPostId) throw new Error('JOIN needs an anchor post');
  if (action === 'JOIN' && anchorPostId === postId && anchorFaultIndex === faultIndex) throw new Error('a post cannot join itself');
  const data = { action, anchorPostId: action === 'JOIN' ? anchorPostId : null, anchorFaultIndex: action === 'JOIN' ? anchorFaultIndex : 0, note, contrastPostId: action === 'SPLIT' ? contrastPostId : null };
  await validateOverrideGraph([{ postId,faultIndex,...data }]);
  return prisma.linkOverride.upsert({ where: { postId_faultIndex: { postId, faultIndex } }, create: { postId, faultIndex, ...data }, update: data });
}

export const clearOverride = (postId, faultIndex = 0) => prisma.linkOverride.deleteMany({ where: { postId, faultIndex } });

/**
 * What to do now, checking a person's correction FIRST and an active automatic repair directive second (never instead
 * of): { action, outageId?, note, source: 'human' | 'auto-directive' } | null. A human LinkOverride always wins - an
 * automatic directive can never replace, contradict or silently reinterpret one (self-correction §4 invariant 3).
 */
export async function resolveDecision(postId, faultIndex, db = prisma) {
  const human = await resolveOverride(postId, faultIndex, db);
  if (human) return { ...human, source: 'human' };
  const directive = await db.autoRepairDirective.findUnique({ where: { postId_faultIndex: { postId, faultIndex } } });
  if (!directive || directive.status !== 'ACTIVE') return null;
  if (directive.action === 'SPLIT') return { action: 'SPLIT', note: `auto-repair: ${directive.policyName}@${directive.policyVersion}`, source: 'auto-directive' };
  const anchor = await db.outagePost.findFirst({ where: { postId: directive.targetAnchorPostId, faultIndex: directive.targetAnchorFaultIndex }, select: { outageId: true, outage: { select: { serviceType: true } } } });
  if (!anchor) return null;
  // A human override is trusted at face value - it is an explicit, informed decision. An automatic directive is not:
  // it is re-checked here, at the point of use, never just at proposal-creation time, so a directive that somehow
  // became stale or wrong can never bridge Water and Electricity even for one post (self-correction §4 invariant 1).
  const post = await db.sourcePost.findUnique({ where: { id: postId }, select: { serviceType: true } });
  if (post && anchor.outage.serviceType !== post.serviceType) return null;
  return { action: 'JOIN', outageId: anchor.outageId, note: `auto-repair: ${directive.policyName}@${directive.policyVersion}`, source: 'auto-directive' };
}

/** Validate the resulting dependency graph, including several changes from one segmentation edit. */
export async function validateOverrideGraph(replacements, db = prisma) {
  const planned = new Map(replacements.map((o) => [`${o.postId}:${o.faultIndex}`,o]));
  for (const root of replacements) {
    let node = root;
    const seen = new Set();
    for (let hops = 0; node?.action === 'JOIN'; hops++) {
      const key = `${node.postId}:${node.faultIndex}`;
      if (seen.has(key) || hops > 500) throw new Error('Human join dependencies are cyclic or too deep. Resolve their anchors first.');
      seen.add(key);
      if (!node.anchorPostId) throw new Error('A human join has no source-post anchor.');
      const nextKey = `${node.anchorPostId}:${node.anchorFaultIndex}`;
      if (seen.has(nextKey)) throw new Error('A human join cannot depend on itself or a cyclic anchor.');
      node = planned.has(nextKey) ? planned.get(nextKey) : await db.linkOverride.findUnique({ where: { postId_faultIndex: { postId: node.anchorPostId,faultIndex: node.anchorFaultIndex } } });
    }
  }
}
