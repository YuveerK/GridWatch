export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function notFound(resource = "Resource") {
  return new AppError(404, "NOT_FOUND", `${resource} was not found`);
}
