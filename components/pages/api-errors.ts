import type { ApiError } from "@/lib/contracts";

export interface DescribedError {
  message: string;
  status?: number;
  code?: string;
  fields?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringFields(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const fields: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) if (typeof text === "string") fields[key] = text;
  return Object.keys(fields).length ? fields : undefined;
}

/**
 * Normalize whatever the shared client helper throws. The helper's error
 * class is owned by the reader agent; this reads the documented ApiError
 * fields ({error, code, fields}) and an HTTP status wherever it is attached.
 */
export function describeError(error: unknown, fallback = "Fever could not complete the request."): DescribedError {
  if (!isRecord(error) && !(error instanceof Error)) return { message: fallback };
  const value = error as Record<string, unknown>;
  const body = isRecord(value.body) ? value.body : isRecord(value.data) ? value.data : isRecord(value.payload) ? value.payload : undefined;
  const response = isRecord(value.response) ? value.response : undefined;
  const status = [value.status, value.statusCode, response?.status].find((entry): entry is number => typeof entry === "number");
  const code = [value.code, body?.code].find((entry): entry is string => typeof entry === "string");
  const fields = stringFields(value.fields) ?? stringFields(body?.fields);
  const bodyMessage = typeof body?.error === "string" ? body.error : undefined;
  let message = bodyMessage ?? (error instanceof Error && error.message ? error.message : typeof value.error === "string" ? value.error : fallback);
  if (error instanceof TypeError && /fetch|network|load failed/i.test(message)) {
    message = "Fever could not be reached. Check your connection and try again.";
  }
  return { message, status, code, fields };
}

export function isSessionError(error: DescribedError): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED" || error.code === "UNAUTHORIZED";
}

/** Read an ApiError body from a raw Response (used where fetch is called directly). */
export async function responseError(response: Response): Promise<DescribedError> {
  let body: Partial<ApiError> | undefined;
  try {
    body = (await response.json()) as Partial<ApiError>;
  } catch {
    body = undefined;
  }
  return {
    message: typeof body?.error === "string" ? body.error : `Fever responded with HTTP ${response.status}.`,
    status: response.status,
    code: typeof body?.code === "string" ? body.code : undefined,
    fields: stringFields(body?.fields),
  };
}
