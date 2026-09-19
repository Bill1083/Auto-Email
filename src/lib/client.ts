/**
 * The one fetch wrapper client components use. Errors carry the server's
 * message so the UI can show it verbatim in a toast.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly details?: { path: string; message: string }[];

  constructor(message: string, status: number, details?: { path: string; message: string }[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit | null } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    cache: 'no-store',
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const payload = (data ?? {}) as { error?: string; details?: { path: string; message: string }[] };
    if (response.status === 401 && typeof window !== 'undefined') {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(payload.error ?? `Request failed (${response.status}).`, response.status, payload.details);
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.details?.[0];
    return detail ? `${error.message} ${detail.path}: ${detail.message}` : error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
