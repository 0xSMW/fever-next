export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
    public readonly code = "UNAUTHENTICATED",
    public readonly retryAfter?: number,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function authErrorResponse(error: unknown): Response {
  const known = error instanceof AuthError;
  return Response.json({
    error: known ? error.message : "The request could not be completed. Try again shortly.",
    code: known ? error.code : "UNAVAILABLE",
    ...(known && error.fields ? { fields: error.fields } : {}),
  }, {
    status: known ? error.status : 503,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Vary": "Cookie",
      ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}),
    },
  });
}

export function invalidInput(message: string, field?: string): never {
  throw new AuthError(message, 400, "INVALID_INPUT", undefined, field ? { [field]: message } : undefined);
}
