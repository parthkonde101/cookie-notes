import 'server-only';
import { NextResponse } from 'next/server';

/**
 * Errors that are safe to show a user. Everything else is logged with a
 * reference id and reported to the client as a generic message, so database and
 * storage internals never reach the browser.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = options.status ?? 400;
    this.code = options.code ?? 'bad_request';
    this.details = options.details;
  }
}

export const Errors = {
  unauthorized: (message = 'You need to sign in to continue.') =>
    new AppError(message, { status: 401, code: 'unauthorized' }),
  forbidden: (message = 'You do not have access to this.') =>
    new AppError(message, { status: 403, code: 'forbidden' }),
  notFound: (message = 'We could not find what you were looking for.') =>
    new AppError(message, { status: 404, code: 'not_found' }),
  conflict: (message: string, details?: unknown) =>
    new AppError(message, { status: 409, code: 'conflict', details }),
  validation: (message: string, details?: unknown) =>
    new AppError(message, { status: 422, code: 'validation_error', details }),
  rateLimited: (message = 'Too many attempts. Please wait a moment and try again.') =>
    new AppError(message, { status: 429, code: 'rate_limited' }),
  sessionConflict: (details: unknown) =>
    new AppError('This account is already active on another device.', {
      status: 409,
      code: 'session_conflict',
      details,
    }),
};

function reference(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Logs the real error server-side and returns a safe JSON response. */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details ?? undefined },
      { status: error.status },
    );
  }

  const ref = reference();
  console.error(`[error:${ref}]`, error);
  return NextResponse.json(
    {
      error: 'Something went wrong on our side. Please try again.',
      code: 'internal_error',
      reference: ref,
    },
    { status: 500 },
  );
}

/** Same idea, for server actions that return a result object rather than a Response. */
export function toActionError(error: unknown): { ok: false; error: string; code: string } {
  if (error instanceof AppError) {
    return { ok: false, error: error.message, code: error.code };
  }
  const ref = reference();
  console.error(`[error:${ref}]`, error);
  return {
    ok: false,
    error: `Something went wrong on our side (ref ${ref}). Please try again.`,
    code: 'internal_error',
  };
}
