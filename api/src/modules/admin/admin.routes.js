import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { createInfrastructureService } from "../infrastructure/infrastructure.service.js";
import { createPostsService } from "../posts/posts.service.js";

export function adminRoutes({ prisma }) {
  const router = Router();
  const infrastructure = createInfrastructureService({ prisma });
  const posts = createPostsService({ prisma });

  router.get("/admin/knowledge/review", asyncHandler(async (_request, response) => response.json(await infrastructure.review())));
  router.post("/admin/knowledge/reconcile", asyncHandler(async (_request, response) => response.status(202).json({ status: "queued", message: "Knowledge reconciliation will run against stored observations." })));
  router.post("/admin/knowledge/relationships/:id/confirm", asyncHandler(async (request, response) => response.json(await prisma.infrastructureRelationship.update({ where: { id: request.params.id }, data: { status: "CONFIRMED" } }))));
  router.post("/admin/knowledge/relationships/:id/reject", asyncHandler(async (request, response) => response.json(await prisma.infrastructureRelationship.update({ where: { id: request.params.id }, data: { status: "REJECTED" } }))));
  router.post("/admin/entity-mentions/:id/resolve", asyncHandler(async (request, response) => response.json(await prisma.entityMention.update({ where: { id: request.params.id }, data: { resolutionStatus: "RESOLVED", resolvedAssetId: request.body.assetId ?? null, resolvedLocalityId: request.body.localityId ?? null } }))));
  router.post("/admin/events/:id/reassign", asyncHandler(async (request, response) => response.json(await prisma.outageEvent.update({ where: { id: request.params.id }, data: { incidentId: request.body.incidentId } }))));
  router.post("/admin/posts/:id/reprocess", asyncHandler(async (request, response) => response.status(202).json(await posts.reprocess(request.params.id))));
  return router;
}
