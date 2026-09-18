import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger.js";
import { requestId } from "./middleware/request-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { createHealthService } from "./modules/health/health.service.js";
import { postRoutes } from "./modules/posts/posts.routes.js";
import { incidentRoutes } from "./modules/incidents/incident.routes.js";
import { infrastructureRoutes } from "./modules/infrastructure/infrastructure.routes.js";
import { localityRoutes } from "./modules/geography/geography.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";

export function createApp({ prisma, schedulerState = {} }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (request) => request.id }));
  app.use("/api", healthRoutes(createHealthService({ prisma, schedulerState })));
  app.use("/api", postRoutes({ prisma }));
  app.use("/api", incidentRoutes({ prisma }));
  app.use("/api", infrastructureRoutes({ prisma }));
  app.use("/api", localityRoutes({ prisma }));
  app.use("/api", adminRoutes({ prisma }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
