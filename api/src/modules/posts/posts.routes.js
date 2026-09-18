import { Router } from "express";
import { z } from "zod";
import { asyncHandler, pageParams } from "../../lib/http.js";
import { createPostsService } from "./posts.service.js";

const listSchema = z.object({ status: z.string().optional(), sourceAccount: z.string().optional() });

export function postRoutes({ prisma }) {
  const router = Router();
  const service = createPostsService({ prisma });
  router.get("/posts", asyncHandler(async (request, response) => {
    const filters = listSchema.parse(request.query);
    response.json(await service.list({ ...pageParams(request.query), ...filters }));
  }));
  router.get("/posts/:id", asyncHandler(async (request, response) => response.json(await service.get(request.params.id))));
  router.post("/admin/posts/:id/reprocess", asyncHandler(async (request, response) => response.status(202).json(await service.reprocess(request.params.id))));
  return router;
}
