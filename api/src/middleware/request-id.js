import { randomUUID } from "node:crypto";

export function requestId(request, response, next) {
  const id = request.get("x-request-id") || randomUUID();
  request.id = id;
  response.setHeader("x-request-id", id);
  next();
}
