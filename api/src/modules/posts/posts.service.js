import { notFound } from "../../lib/errors.js";
import { pageResult } from "../../lib/http.js";

function serializePost(post) {
  return {
    id: post.id,
    platform: post.platform,
    sourceAccount: post.sourceAccount,
    externalId: post.externalId,
    text: post.text,
    noteTweetText: post.noteTweetText,
    publishedAt: post.publishedAt,
    processingStatus: post.processingStatus,
    media: post.media ?? [],
    processingRuns: post.processingRuns ?? undefined,
    entityMentions: post.entityMentions ?? undefined,
    unresolvedMentions: post.unresolvedMentions ?? undefined,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

export function createPostsService({ prisma }) {
  return {
    async list({ page, pageSize, status, sourceAccount }) {
      const where = { ...(status ? { processingStatus: status } : {}), ...(sourceAccount ? { sourceAccount } : {}) };
      const [items, total] = await prisma.$transaction([
        prisma.sourcePost.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { publishedAt: "desc" }, include: { media: true } }),
        prisma.sourcePost.count({ where }),
      ]);
      return pageResult(items.map(serializePost), total, { page, pageSize });
    },
    async get(id) {
      const post = await prisma.sourcePost.findUnique({ where: { id }, include: { media: { include: { ocrResults: true } }, processingRuns: { include: { extraction: true }, orderBy: { attempt: "desc" } }, entityMentions: true, unresolvedMentions: true } });
      if (!post) throw notFound("Source post");
      return serializePost({ ...post, processingRuns: post.processingRuns, entityMentions: post.entityMentions, unresolvedMentions: post.unresolvedMentions });
    },
    async reprocess(id) {
      const post = await prisma.sourcePost.findUnique({ where: { id }, select: { id: true } });
      if (!post) throw notFound("Source post");
      const latest = await prisma.postProcessingRun.findFirst({ where: { postId: id }, orderBy: { attempt: "desc" }, select: { attempt: true } });
      const run = await prisma.postProcessingRun.create({ data: { postId: id, attempt: (latest?.attempt ?? 0) + 1, status: "RUNNING" } });
      await prisma.sourcePost.update({ where: { id }, data: { processingStatus: "UNPROCESSED", processingStartedAt: null } });
      return { id: run.id, postId: id, status: run.status, attempt: run.attempt };
    },
  };
}
