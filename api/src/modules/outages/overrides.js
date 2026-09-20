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
 * A JOIN whose anchor is not linked yet (it comes later in a rebuild) says nothing, and the normal rules decide.
 */
export async function resolveOverride(postId, faultIndex, db = prisma) {
  const o = await overrideFor(postId, faultIndex, db);
  if (!o) return null;
  if (o.action === 'SPLIT') return { action: 'SPLIT', note: o.note };
  const anchor = await db.outagePost.findFirst({ where: { postId: o.anchorPostId, faultIndex: o.anchorFaultIndex }, select: { outageId: true } });
  return anchor ? { action: 'JOIN', outageId: anchor.outageId, note: o.note } : null;
}

export async function setOverride({ postId, faultIndex = 0, action, anchorPostId = null, anchorFaultIndex = 0, note = null }) {
  if (action !== 'SPLIT' && action !== 'JOIN') throw new Error('action must be SPLIT or JOIN');
  if (action === 'JOIN' && !anchorPostId) throw new Error('JOIN needs an anchor post');
  if (action === 'JOIN' && anchorPostId === postId && anchorFaultIndex === faultIndex) throw new Error('a post cannot join itself');
  const data = { action, anchorPostId: action === 'JOIN' ? anchorPostId : null, anchorFaultIndex: action === 'JOIN' ? anchorFaultIndex : 0, note };
  return prisma.linkOverride.upsert({ where: { postId_faultIndex: { postId, faultIndex } }, create: { postId, faultIndex, ...data }, update: data });
}

export const clearOverride = (postId, faultIndex = 0) => prisma.linkOverride.deleteMany({ where: { postId, faultIndex } });
