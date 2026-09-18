import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger.js";

function mediaFromResponse(payload) {
  const media = new Map((payload.includes?.media ?? []).map((item) => [item.media_key, item]));
  return (payload.data?.attachments?.media_keys ?? []).map((key) => media.get(key)).filter(Boolean);
}

export function createIngestionService({ prisma, xClient, sourceAccount }) {
  return {
    async run() {
      const lock = await prisma.$queryRaw`SELECT pg_try_advisory_lock(hashtext('gridwatch:x-ingestion')) AS locked`;
      if (!lock[0]?.locked) return { skipped: true, reason: "lock_held" };
      let run;
      let pages = 0;
      let fetched = 0;
      let inserted = 0;
      try {
      const account = await prisma.sourceAccount.upsert({ where: { externalId: sourceAccount.externalId }, update: { displayName: sourceAccount.displayName, active: true }, create: sourceAccount });
      const latest = await prisma.sourcePost.findFirst({ where: { sourceAccount: sourceAccount.displayName }, orderBy: { publishedAt: "desc" }, select: { externalId: true } });
      run = await prisma.ingestionRun.create({ data: { sourceAccountId: account.id, checkpointBefore: latest?.externalId } });
      let token;
        do {
          const payload = await xClient.listPosts({ userId: sourceAccount.externalId, sinceId: latest?.externalId, paginationToken: token });
          pages += 1;
          const media = mediaFromResponse(payload);
          for (const item of payload.data ?? []) {
            const publishedAt = new Date(item.created_at);
            const existing = await prisma.sourcePost.findUnique({ where: { platform_externalId: { platform: "X", externalId: item.id } }, select: { id: true } });
            const post = await prisma.sourcePost.upsert({ where: { platform_externalId: { platform: "X", externalId: item.id } }, update: { rawPayload: item, text: item.text ?? "", noteTweetText: item.note_tweet?.text ?? null, attachments: item.attachments ?? null, publicMetrics: item.public_metrics ?? null, updatedAt: new Date() }, create: { id: randomUUID(), platform: "X", sourceAccount: sourceAccount.displayName, externalId: item.id, authorId: item.author_id ?? null, conversationId: item.conversation_id ?? null, text: item.text ?? "", language: item.lang ?? null, publishedAt, publicMetrics: item.public_metrics ?? null, attachments: item.attachments ?? null, rawPayload: item, noteTweetText: item.note_tweet?.text ?? null } });
            fetched += 1;
            if (!existing) inserted += 1;
            await prisma.ingestionRunPost.upsert({ where: { ingestionRunId_postId: { ingestionRunId: run.id, postId: post.id } }, update: {}, create: { ingestionRunId: run.id, postId: post.id } });
            for (const itemMedia of media.filter((candidate) => item.attachments?.media_keys?.includes(candidate.media_key))) {
              await prisma.postMedia.upsert({ where: { postId_mediaKey: { postId: post.id, mediaKey: itemMedia.media_key } }, update: { url: itemMedia.url ?? itemMedia.preview_image_url ?? "", metadata: itemMedia }, create: { postId: post.id, mediaKey: itemMedia.media_key, mediaType: itemMedia.type, url: itemMedia.url ?? itemMedia.preview_image_url ?? "", width: itemMedia.width, height: itemMedia.height, durationMs: itemMedia.duration_ms, metadata: itemMedia } });
            }
          }
          token = payload.meta?.next_token;
        } while (token);
        const checkpoint = await prisma.sourcePost.findFirst({ where: { sourceAccount: sourceAccount.displayName }, orderBy: { publishedAt: "desc" }, select: { externalId: true } });
        await prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", checkpointAfter: checkpoint?.externalId, pagesFetched: pages, postsFetched: fetched, postsInserted: inserted, postsDeduplicated: fetched - inserted, completedAt: new Date() } });
        return { runId: run.id, pages, fetched, inserted, checkpoint: checkpoint?.externalId ?? null };
      } catch (error) {
        if (run) await prisma.ingestionRun.update({ where: { id: run.id }, data: { status: error.code === "X_RATE_LIMIT" ? "RATE_LIMITED" : "FAILED", pagesFetched: pages, postsFetched: fetched, errorCategory: error.code ?? "INGESTION_ERROR", errorMessage: error.message, completedAt: new Date() } });
        logger.error({ err: error, ingestionRunId: run?.id }, "X ingestion failed");
        throw error;
      } finally {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext('gridwatch:x-ingestion'))`;
      }
    },
  };
}
