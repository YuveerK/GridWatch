export async function retryFailed({ prisma, limit = 25 }) {
  return prisma.sourcePost.updateMany({ where: { processingStatus: "PROCESSING_ERROR" }, data: { processingStatus: "UNPROCESSED", processingStartedAt: null } });
}
