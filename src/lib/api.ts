/**
 * Shared helpers for route handlers: one response envelope, one error shape.
 */

import { NextResponse } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef, type infer as ZodInfer } from 'zod';

export interface ApiError {
  error: string;
  /** Field-level detail for validation failures. */
  details?: { path: string; message: string }[];
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function fail(
  message: string,
  status = 400,
  details?: ApiError['details'],
): NextResponse<ApiError> {
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status });
}

/**
 * Parse and validate a JSON request body.
 *
 * Returns a discriminated result rather than throwing so handlers stay flat.
 */
export async function readJson<S extends ZodType<unknown, ZodTypeDef, unknown>>(
  request: Request,
  schema: S,
  maxBytes = 8 * 1024 * 1024,
): Promise<
  | { ok: true; data: ZodInfer<S> }
  | { ok: false; response: NextResponse<ApiError> }
> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) {
    return {
      ok: false,
      response: fail(
        `Request body is too large (limit ${Math.round(maxBytes / 1024 / 1024)}MB).`,
        413,
      ),
    };
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: fail('Request body must be valid JSON.', 400) };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail('Request validation failed.', 422, zodDetails(parsed.error)),
    };
  }
  return { ok: true, data: parsed.data as ZodInfer<S> };
}

export function zodDetails(error: ZodError): ApiError['details'] {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Wrap a handler so an unexpected throw becomes a 500 with a safe message
 * instead of an unhandled rejection.
 */
export async function guard<R extends NextResponse<unknown>>(
  handler: () => Promise<R>,
  context: string,
): Promise<R | NextResponse<ApiError>> {
  try {
    return await handler();
  } catch (error) {
    console.error(`[automail] ${context} failed:`, error);
    return fail(
      'Something went wrong handling that request. Check the server logs for detail.',
      500,
    );
  }
}

/** `YYYY-MM-DD` guard for query parameters. */
export function isDateKey(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
