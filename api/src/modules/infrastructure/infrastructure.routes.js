import { Router } from "express";
import { asyncHandler, pageParams } from "../../lib/http.js";
import { createInfrastructureService } from "./infrastructure.service.js";

export function infrastructureRoutes({ prisma }) {
  const router = Router();
  const service = createInfrastructureService({ prisma });
  router.get("/infrastructure", asyncHandler(async (request, response) => response.json(await service.list({ ...pageParams(request.query), q: request.query.q, type: request.query.type, status: request.query.status }))));
  router.get("/infrastructure/:id", asyncHandler(async (request, response) => response.json(await service.get(request.params.id))));
  router.get("/infrastructure/:id/graph", asyncHandler(async (request, response) => response.json(await service.graph(request.params.id))));
  router.get("/infrastructure/:id/timeline", asyncHandler(async (request, response) => response.json(await service.timeline(request.params.id))));
  return router;
}
