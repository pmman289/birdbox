export interface PublicError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
}

export type UnknownRecord = Record<string, unknown>;

export function fail(status: number, message: string, code?: string): never {
  const error = new Error(message) as PublicError;
  error.status = status;
  if (code) error.code = code;
  throw error;
}

export function isPublicError(error: unknown): error is PublicError {
  const candidate = error as PublicError | null;
  const status = candidate?.status ?? candidate?.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

export function safeErrorMessage(error: unknown): string {
  return isPublicError(error) ? error.message : "服务器内部错误";
}

export function record(value: unknown, message: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, message);
  return value as UnknownRecord;
}

export function optionalRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}
