import { prisma } from '../../db/prisma.js';
import { edgeEvidenceRef } from '../../lib/evidence-edge.js';
import { postUrl } from './municipality-scope.js';

/** Source counts are distinct documents/posts, never the legacy evidenceCount default. */
export async function networkEvidence(nodeId, { parentId, childId, relationType = 'LEGACY_PARENT', localityId, kind = 'documents', offset = 0, limit = 20 }) {
  const edge = parentId && childId;
  const official = edge ? { parentId, childId, relationType } : localityId ? { nodeId, localityId } : { nodeId, parentId: null, childId: null, localityId: null };
  const contribution = edge ? { kind: 'EDGE', refA: parentId, refB: edgeEvidenceRef(childId, relationType) }
    : localityId ? { kind: 'NODE_LOCALITY', refA: nodeId, refB: localityId } : { kind: 'NODE', refA: nodeId };
  const documentsWhere = { evidence: { some: official } };
  const postsWhere = { evidence: { some: contribution } };
  const [documents, posts] = await Promise.all([
    prisma.knowledgeSource.count({ where: documentsWhere }),
    prisma.sourcePost.count({ where: postsWhere }),
  ]);
  const rows = kind === 'posts'
    ? await prisma.sourcePost.findMany({ where: postsWhere, orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }], skip: offset, take: limit, select: { id: true, sourceAccount: true, externalId: true, text: true, noteTweetText: true, publishedAt: true } })
    : await prisma.knowledgeSource.findMany({ where: documentsWhere, orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }], skip: offset, take: limit, select: { id: true, title: true, sourceType: true, url: true, publishedAt: true, fetchedAt: true } });
  const total = kind === 'posts' ? posts : documents;
  return { documents, posts, total, offset, limit, hasMore: offset + rows.length < total, data: rows.map((r) => kind === 'posts' ? { id: r.id, sourceType: 'SOCIAL_POST', title: r.sourceAccount, text: r.noteTweetText || r.text, publishedAt: r.publishedAt, url: postUrl(r.sourceAccount, r.externalId) } : r) };
}
