export class ServiceError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public retryable = false,
    public param: string | null = null,
    public upstreamCode?: number,
    public upstreamStatus?: number,
  ) { super(message); }
}

export const invalid = (message: string, code = "invalid_request", param: string | null = null) =>
  new ServiceError(code, 400, message, false, param);

export function asServiceError(error: unknown): ServiceError {
  return error instanceof ServiceError ? error :
    new ServiceError("internal_error", 500, "Internal service error.");
}
