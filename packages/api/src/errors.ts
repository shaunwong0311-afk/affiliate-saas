export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (m: string) => new HttpError(400, m, "bad_request");
export const unauthorized = (m = "unauthorized") => new HttpError(401, m, "unauthorized");
export const forbidden = (m = "forbidden") => new HttpError(403, m, "forbidden");
export const notFound = (m = "not found") => new HttpError(404, m, "not_found");
export const conflict = (m: string) => new HttpError(409, m, "conflict");
export const tooManyRequests = (m = "too many requests") => new HttpError(429, m, "rate_limited");
export const serviceUnavailable = (m: string, code = "unavailable") => new HttpError(503, m, code);

/**
 * "Row not found" raised by the data layer (`repo.require()` / `repo.update()`): the
 * in-memory adapter throws a `NotFoundError`, the Postgres adapter a plain Error with the
 * same message. Both mean the client asked for something that is not there — a 404, never
 * a 500.
 */
export function isDataNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "NotFoundError" || /^row not found: /.test(error.message);
}
