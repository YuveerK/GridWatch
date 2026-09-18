import { processPost } from "../src/modules/processing/processor.service.js";

export async function processPendingPosts({ prisma, limit = 2 }) {
  const posts = await prisma.sourcePost.findMany({ where: { processingStatus: { in: ["UNPROCESSED", "PROCESSING_ERROR"] } }, orderBy: { publishedAt: "asc" }, take: limit, select: { id: true } });
  const results = [];
  for (const post of posts) results.push(await processPost({ prisma, postId: post.id }));
  return results;
}
