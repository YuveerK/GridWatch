import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";

export function healthRoutes(service) {
  const router = Router();
  router.get("/health", asyncHandler(async (_request, response) => response.json(await service.readiness())));
  router.get("/health/worker", (_request, response) => response.json(service.freshness()));
  return router;
}
