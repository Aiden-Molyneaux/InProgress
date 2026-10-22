export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
    /** Typed fields the answer carries beside error and hint, e.g. { code: 'page-missing' }. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (message: string, hint?: string) => new ApiError(404, message, hint);
export const badRequest = (message: string, hint?: string) => new ApiError(400, message, hint);
export const conflict = (message: string, hint?: string) => new ApiError(409, message, hint);
/** A request the server understood but cannot answer for what the target holds, e.g. a page with a secret in it. */
export const unprocessable = (message: string, hint?: string, extra?: Record<string, string | number>) => new ApiError(422, message, hint, extra);
