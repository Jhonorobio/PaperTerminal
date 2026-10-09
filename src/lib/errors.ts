/**
 * Error type shared by every layer, local or remote. Extracted from `api.ts` so the market feed and
 * the trading engine can throw the same shape screens already handle (`ApiError` was re-exported
 * from `api.ts` and that still works — see the bottom of `./api`).
 */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}
