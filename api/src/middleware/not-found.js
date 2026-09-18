export function notFoundHandler(request, response) {
  response.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.path} was not found` }, requestId: request.id });
}
