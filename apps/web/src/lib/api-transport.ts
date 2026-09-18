import {
  type ApiRequestOptions,
  apiFetch,
  requestSignal,
} from "./api-fetch.ts";

export { ApiIdentityError } from "./api-fetch.ts";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export class ApiCommunicationError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "ApiCommunicationError";
  }
}

export class ApiHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function cancellationReason(signal: AbortSignal | null | undefined): unknown {
  return signal?.aborted ? signal.reason : undefined;
}

function rethrowTransportError(
  error: unknown,
  signal: AbortSignal | null | undefined,
): never {
  const reason = cancellationReason(signal);
  if (reason !== undefined) {
    throw reason;
  }
  if (isAbortError(error)) {
    throw error;
  }
  if (error instanceof TypeError) {
    throw new ApiCommunicationError("Request communication failed", {
      cause: error,
    });
  }
  throw error;
}

function fallbackError(response: Response): string {
  return response.statusText;
}

function parseErrorBody(response: Response, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string"
      ? parsed.error
      : fallbackError(response);
  } catch {
    return fallbackError(response);
  }
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  const signal = requestSignal(input, init);

  let response: Response;
  try {
    response = await apiFetch(input, init, options);
  } catch (error) {
    rethrowTransportError(error, signal);
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    const reason = cancellationReason(signal);
    if (reason !== undefined) {
      throw reason;
    }
    if (isAbortError(error)) {
      throw error;
    }
    if (!response.ok && error instanceof TypeError) {
      return {
        error: fallbackError(response),
        ok: false,
        status: response.status,
      };
    }
    rethrowTransportError(error, signal);
  }

  if (signal?.aborted) {
    throw signal.reason;
  }
  if (!response.ok) {
    return {
      error: parseErrorBody(response, body),
      ok: false,
      status: response.status,
    };
  }

  return { data: JSON.parse(body) as T, ok: true };
}
