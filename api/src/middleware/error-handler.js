import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function errorHandler(error, request, response, _next) {
  if (error instanceof ZodError) {
    return response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues }, requestId: request.id });
  }
  const appError = error instanceof AppError ? error : null;
  const status = appError?.statusCode ?? 500;
  const code = appError?.code ?? "INTERNAL_ERROR";
  const message = appError?.message ?? "An unexpected error occurred";
  if (status >= 500) logger.error({ err: error, requestId: request.id }, message);
  return response.status(status).json({ error: { code, message, ...(appError?.details ? { details: appError.details } : {}) }, requestId: request.id });
}
