import { processPost } from "../src/modules/processing/processor.service.js";
import { prisma } from "../src/db/prisma.js";

const args = new Set(process.argv.slice(2));
const postId = process.argv.slice(2).find((value) => value.startsWith("--post-id="))?.split("=")[1] ?? process.env.BACKFILL_POST_ID ?? null;
const force = args.has("--force");
const dryRun = args.has("--dry-run");
const postSelect = {
  id: true,
  externalId: true,
  text: true,
  publishedAt: true,
  processingStatus: true,
  attachments: true,
};

function log(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

try {
  log("backfill.started", { postId, force, dryRun });
  const post = await findPost(postId);
  if (!post) throw new Error("No stored SourcePost with a photo attachment was found");

  const attachments = extractMedia(post.attachments);
  log("post.selected", {
    postId: post.id,
    externalId: post.externalId,
    publishedAt: post.publishedAt,
    processingStatus: post.processingStatus,
    textPreview: post.text.slice(0, 180),
    attachmentCount: attachments.length,
  });

  if (dryRun) {
    log("backfill.dry_run", { selectedMedia: attachments[0] });
    process.exitCode = 0;
  } else {
    if (!["UNPROCESSED", "PROCESSING_ERROR"].includes(post.processingStatus) && !force) {
      throw new Error(`Post is ${post.processingStatus}; rerun with --force to explicitly reprocess it`);
    }

    const media = await materializeFirstPhoto(post.id, attachments);
    if (!media) throw new Error("The selected post has no usable photo URL");
    log("media.materialized", { mediaId: media.id, mediaKey: media.mediaKey, url: media.url, mediaType: media.mediaType });

    if (force) {
      await prisma.sourcePost.update({ where: { id: post.id }, data: { processingStatus: "UNPROCESSED", processingStartedAt: null } });
      log("post.reset_for_test", { postId: post.id });
    }

    const result = await processPost({
      prisma,
      postId: post.id,
      onStage: async (stage) => log(`pipeline.${stage.stage}`, { postId: post.id, ...stage }),
    });
    log("pipeline.result", result);
    await logPersistenceSummary(post.id);
  }
} catch (error) {
  log("backfill.failed", { code: error.code ?? "BACKFILL_ERROR", message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

async function findPost(id) {
  if (id) {
    const post = await prisma.sourcePost.findUnique({ where: { id }, select: postSelect });
    return post && extractMedia(post.attachments).some((media) => media.type === "photo") ? post : null;
  }
  const candidates = await prisma.sourcePost.findMany({ where: { attachments: { not: null } }, orderBy: { publishedAt: "asc" }, take: 250, select: postSelect });
  return candidates.find((post) => extractMedia(post.attachments).some((media) => media.type === "photo")) ?? null;
}

function extractMedia(attachments) {
  const value = attachments && typeof attachments === "object" ? attachments : {};
  const media = Array.isArray(value.media) ? value.media : [];
  return media
    .map((item) => ({
      mediaKey: item.media_key ?? item.mediaKey ?? item.url,
      type: item.type ?? item.mediaType ?? "photo",
      url: item.url ?? item.preview_image_url ?? item.previewImageUrl,
      width: Number.isFinite(item.width) ? item.width : null,
      height: Number.isFinite(item.height) ? item.height : null,
      durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : item.durationMs ?? null,
      metadata: item,
    }))
    .filter((item) => item.mediaKey && item.url);
}

async function materializeFirstPhoto(sourcePostId, attachments) {
  const item = attachments.find((media) => media.type === "photo");
  if (!item) return null;
  return prisma.postMedia.upsert({
    where: { postId_mediaKey: { postId: sourcePostId, mediaKey: item.mediaKey } },
    update: { mediaType: item.type, url: item.url, width: item.width, height: item.height, durationMs: item.durationMs, metadata: item.metadata },
    create: { postId: sourcePostId, mediaKey: item.mediaKey, mediaType: item.type, url: item.url, width: item.width, height: item.height, durationMs: item.durationMs, metadata: item.metadata },
  });
}

async function logPersistenceSummary(sourcePostId) {
  const [post, latestRun, mediaCount, ocrCount, observationCount, mentionCount, unresolvedCount, eventCount] = await Promise.all([
    prisma.sourcePost.findUnique({ where: { id: sourcePostId }, select: { processingStatus: true } }),
    prisma.postProcessingRun.findFirst({ where: { postId: sourcePostId }, orderBy: { attempt: "desc" }, select: { id: true, postId: true, attempt: true, status: true, modelName: true, promptVersion: true, schemaVersion: true, errorCategory: true, errorMessage: true, startedAt: true, completedAt: true, durationMs: true, extraction: { select: { id: true, relevance: true, eventType: true, affectedAreas: true, infrastructure: true, relationships: true } } } }),
    prisma.postMedia.count({ where: { postId: sourcePostId } }),
    prisma.ocrResult.count({ where: { media: { postId: sourcePostId }, status: "SUCCEEDED" } }),
    prisma.infrastructureObservation.count({ where: { postId: sourcePostId } }),
    prisma.entityMention.count({ where: { postId: sourcePostId } }),
    prisma.unresolvedEntityMention.count({ where: { postId: sourcePostId } }),
    prisma.outageEvent.count({ where: { postId: sourcePostId } }),
  ]);
  log("pipeline.persistence_summary", { processingStatus: post?.processingStatus, mediaCount, ocrCount, latestRun, observationCount, mentionCount, unresolvedCount, eventCount });
}
