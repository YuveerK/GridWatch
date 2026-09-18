import { Router } from "express";
import { asyncHandler, pageParams } from "../../lib/http.js";
import { createIncidentService } from "./incident.service.js";

export function incidentRoutes({ prisma }) {
  const router = Router();
  const service = createIncidentService({ prisma });
  router.get("/incidents", asyncHandler(async (request, response) => response.json(await service.list({ ...pageParams(request.query), status: request.query.status, q: request.query.q }))));
  router.get("/incidents/:id", asyncHandler(async (request, response) => response.json(await service.get(request.params.id))));
  router.get("/dashboard/summary", asyncHandler(async (_request, response) => response.json(await service.summary())));
  router.post("/admin/incidents/:id/merge", asyncHandler(async (request, response) => response.json(await service.merge(request.params.id, request.body.sourceIncidentId))));
  return router;
}
