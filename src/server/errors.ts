export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (message: string, hint?: string) => new ApiError(404, message, hint);
export const badRequest = (message: string, hint?: string) => new ApiError(400, message, hint);
export const conflict = (message: string, hint?: string) => new ApiError(409, message, hint);
