import { ApiRequestError } from "./api";

export interface ClientError { message: string; fields: Record<string, string>; status?: number; code?: string; }
export function describeError(error: unknown, fallback = "Fever could not complete the request."): ClientError {
  if (error instanceof ApiRequestError) return { message: error.message || fallback, fields: error.fields ?? {}, status: error.status, code: error.code };
  if (error instanceof Error) return { message: error instanceof TypeError && /fetch|network|load failed/i.test(error.message) ? "Fever could not be reached. Check your connection and try again." : error.message || fallback, fields: {} };
  return { message: fallback, fields: {} };
}
export type DescribedError = ClientError;
export function isSessionError(error: ClientError): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED" || error.code === "UNAUTHORIZED";
}
