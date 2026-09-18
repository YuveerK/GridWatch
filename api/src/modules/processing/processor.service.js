import { config } from "../../config/env.js";
import { createGeminiClient } from "../ai/gemini.client.js";
import { createExtractionService } from "../ai/extraction.service.js";
import { createMediaService } from "../media/media.service.js";
import { createKnowledgeReconciliationService } from "../infrastructure/knowledge-reconciliation.service.js";
import { normalizeLabel } from "../geography/normalization.js";
import { createKnowledgeContextService } from "../infrastructure/knowledge-context.service.js";
import { logger } from "../../lib/logger.js";

const activeStatuses = new Set(["OUTAGE", "UPDATE", "RESTORATION", "PLANNED_OUTAGE"]);
const outageStatus = (value) => ({ ACTIVE: "ACTIVE", INVESTIGATING: "INVESTIGATING", REPAIRING: "REPAIRING", RESTORING: "RESTORING", RESTORED: "RESTORED", PARTIALLY_RESTORED: "PARTIALLY_RESTORED", PLANNED: "PLANNED", CANCELLED: "CANCELLED" }[value] ?? "UNKNOWN");

export async function processPost({ prisma, postId, extractionService = null, mediaService = null, onStage = null }) {
  const emit = async (stage, details = {}) => {
    if (!onStage) return;
    try { await onStage({ stage, ...details }); } catch (error) { logger.warn({ err: error, postId, stage }, "Processing stage logger failed"); }
  };

  await emit("claim.started");
  const claimed = await prisma.sourcePost.updateMany({ where: { id: postId, processingStatus: { in: ["UNPROCESSED", "PROCESSING_ERROR"] } }, data: { processingStatus: "PROCESSING", processingStartedAt: new Date() } });
  if (claimed.count === 0) { await emit("claim.skipped", { reason: "post_not_unprocessed" }); return { postId, status: "SKIPPED" }; }
  const post = await prisma.sourcePost.findUnique({ where: { id: postId }, include: { media: { include: { ocrResults: true } } } });
  const previous = await prisma.postProcessingRun.findFirst({ where: { postId }, orderBy: { attempt: "desc" }, select: { attempt: true } });
  const processingRun = await prisma.postProcessingRun.create({ data: { postId, attempt: (previous?.attempt ?? 0) + 1, status: "RUNNING", modelName: config.GEMINI_MODEL, promptVersion: config.AI_PROMPT_VERSION, schemaVersion: config.AI_SCHEMA_VERSION } });
  const startedAt = Date.now();
  await emit("claim.succeeded", { processingRunId: processingRun.id, attempt: processingRun.attempt, mediaCount: post.media.length });
  const mediaProcessor = mediaService ?? createMediaService({ prisma, maxBytes: config.MEDIA_MAX_BYTES, timeoutMs: config.MEDIA_TIMEOUT_MS, language: config.OCR_LANGUAGE });
  try {
    for (const media of post.media.filter((item) => item.mediaType === "photo" && item.url)) {
      await emit("ocr.started", { mediaId: media.id, url: media.url });
      try {
        const results = await mediaProcessor.processMedia(media);
        await emit("ocr.succeeded", { mediaId: media.id, variants: results.length });
      } catch (error) {
        await emit("ocr.failed", { mediaId: media.id, error: error.message });
        logger.warn({ err: error, postId, mediaId: media.id }, "OCR failed; continuing with source text");
      }
    }
    const ocr = await prisma.ocrResult.findMany({ where: { media: { postId }, status: "SUCCEEDED" }, select: { mediaId: true, normalizedText: true, confidence: true } });
    await emit("ocr.completed", { successfulResults: ocr.length });
    const extractor = extractionService ?? createExtractionService({ geminiClient: createGeminiClient({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL, timeoutMs: config.GEMINI_TIMEOUT_MS }), schemaVersion: config.AI_SCHEMA_VERSION });
    await emit("gemini.started", { model: config.GEMINI_MODEL, promptVersion: config.AI_PROMPT_VERSION, schemaVersion: config.AI_SCHEMA_VERSION, ocrResults: ocr.length });
    const knowledgeContext = await createKnowledgeContextService({ prisma, maxAssets: config.KNOWLEDGE_CONTEXT_MAX_ASSETS, maxRelationships: config.KNOWLEDGE_CONTEXT_MAX_RELATIONSHIPS }).build({ text: post.text, ocrText: ocr.map((item) => item.normalizedText).filter(Boolean).join("\n") });
    await emit("knowledge_context.ready", { assets: knowledgeContext.assets?.length ?? 0, relationships: knowledgeContext.relationships?.length ?? 0, localities: knowledgeContext.localities?.length ?? 0 });
    const result = await extractor.extract({ post, ocr, knowledgeContext });
    await emit("gemini.succeeded", { relevance: result.parsed.relevance, eventType: result.parsed.eventType ?? null });
    const saved = await prisma.$transaction(async (tx) => {
      const extraction = await tx.postExtraction.create({ data: { processingRunId: processingRun.id, relevance: result.parsed.relevance, summary: result.parsed.summary ?? null, eventType: result.parsed.eventType ?? null, reportedStatus: result.parsed.reportedStatus ?? null, cause: result.parsed.cause ?? null, eta: result.parsed.eta ?? null, restoration: result.parsed.restoration, referenceNumbers: result.parsed.referenceNumbers, affectedAreas: result.parsed.affectedAreas, infrastructure: result.parsed.infrastructure, relationships: result.parsed.infrastructureRelationships, aliasObservations: result.parsed.aliasObservations, recommendedAssociation: result.parsed.recommendedAssociation ?? null, parsedResult: result.parsed } });
      await tx.postProcessingRun.update({ where: { id: processingRun.id }, data: { status: "SUCCEEDED", rawModelOutput: result.rawModelOutput, completedAt: new Date(), durationMs: Date.now() - startedAt } });
      await tx.sourcePost.update({ where: { id: postId }, data: { processingStatus: result.parsed.relevance === "IRRELEVANT" ? "IRRELEVANT" : (result.parsed.recommendedAssociation?.action === "NONE" ? "NEEDS_REVIEW" : "RELEVANT"), processingStartedAt: null } });
      return extraction;
    });
    await emit("extraction.persisted", { extractionId: saved.id });
    await createKnowledgeReconciliationService({ prisma }).persistExtraction({ post, processingRun, extraction: saved });
    await emit("knowledge.reconciled");
    if (activeStatuses.has(saved.relevance)) {
      const incident = await associateIncident({ prisma, post, processingRun, extraction: saved });
      await emit("incident.associated", { incidentId: incident.id, relevance: saved.relevance });
    } else await emit("incident.skipped", { reason: "non_event_relevance", relevance: saved.relevance });
    const output = { postId, processingRunId: processingRun.id, status: "SUCCEEDED", relevance: saved.relevance };
    await emit("complete", output);
    return output;
  } catch (error) {
    await emit("failed", { error: error.message, code: error.code ?? "PROCESSING_ERROR" });
    await prisma.postProcessingRun.update({ where: { id: processingRun.id }, data: { status: "RETRYABLE", errorCategory: error.code ?? "PROCESSING_ERROR", errorMessage: error.message, completedAt: new Date(), durationMs: Date.now() - startedAt } });
    await prisma.sourcePost.update({ where: { id: postId }, data: { processingStatus: "PROCESSING_ERROR", processingStartedAt: null } });
    throw error;
  }
}

async function associateIncident({ prisma, post, processingRun, extraction }) {
  const status = outageStatus(extraction.reportedStatus);
  const areaNames = new Set((extraction.affectedAreas ?? []).map((area) => normalizeLabel(area.name)));
  const candidates = await prisma.outageIncident.findMany({ where: { status: { in: ["ACTIVE", "INVESTIGATING", "REPAIRING", "RESTORING", "PARTIALLY_RESTORED", "PLANNED"] }, updatedAt: { gte: new Date(post.publishedAt.getTime() - 14 * 24 * 60 * 60 * 1000) } }, include: { localities: { include: { locality: true } } }, orderBy: { updatedAt: "desc" }, take: 50 });
  let incident = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const candidateNames = new Set(candidate.localities.map((link) => link.locality.normalizedName));
    const overlap = [...areaNames].filter((name) => candidateNames.has(name)).length;
    const score = areaNames.size ? overlap / areaNames.size : 0;
    if (score > bestScore) { bestScore = score; incident = candidate; }
  }
  if (!incident || bestScore < config.INCIDENT_ASSOCIATION_THRESHOLD) incident = await prisma.outageIncident.create({ data: { title: extraction.summary || post.text.slice(0, 160), status, reportedAt: post.publishedAt, startedAt: post.publishedAt, causeText: extraction.cause?.text ?? null, causeConfidence: extraction.cause?.confidence ?? null, etaText: extraction.eta?.text ?? null, confidence: extraction.recommendedAssociation?.confidence ?? 0 } });
  else incident = await prisma.outageIncident.update({ where: { id: incident.id }, data: { status, updatedAt: new Date(), restoredAt: status === "RESTORED" ? post.publishedAt : undefined, causeText: extraction.cause?.text ?? undefined, etaText: extraction.eta?.text ?? undefined } });
  await prisma.outageEvent.upsert({ where: { incidentId_postId: { incidentId: incident.id, postId: post.id } }, update: { processingRunId: processingRun.id, eventAt: post.publishedAt, eventType: extraction.eventType ?? "INFORMATION", status, summary: extraction.summary, payload: extraction.parsedResult ?? extraction }, create: { incidentId: incident.id, postId: post.id, processingRunId: processingRun.id, eventAt: post.publishedAt, eventType: extraction.eventType ?? "INFORMATION", status, summary: extraction.summary, payload: extraction.parsedResult ?? extraction } });
  for (const area of extraction.affectedAreas ?? []) {
    const locality = await prisma.locality.findFirst({ where: { normalizedName: normalizeLabel(area.name), active: true } });
    if (locality) await prisma.outageLocality.upsert({ where: { incidentId_localityId: { incidentId: incident.id, localityId: locality.id } }, update: { evidenceType: "CURRENTLY_CONFIRMED", confidence: area.confidence }, create: { incidentId: incident.id, localityId: locality.id, evidenceType: "CURRENTLY_CONFIRMED", confidence: area.confidence } });
  }
  return incident;
}
