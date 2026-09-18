import { Router } from "express";
import { asyncHandler, pageParams } from "../../lib/http.js";
import { createGeographyService } from "./geography.service.js";

export function localityRoutes({ prisma }) {
  const router = Router();
  const service = createGeographyService({ prisma });
  router.get("/localities", asyncHandler(async (request, response) => response.json(await service.list({ ...pageParams(request.query), q: request.query.q, region: request.query.region }))));
  router.get("/localities/:id/infrastructure", asyncHandler(async (request, response) => response.json(await service.infrastructureForLocality(request.params.id))));
  return router;
}
