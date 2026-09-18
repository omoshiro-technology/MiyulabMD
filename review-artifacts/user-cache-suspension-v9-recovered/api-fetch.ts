import { notifyDriveChanged } from "./drive-changed.ts";
import { runMutation } from "./viewing-access.ts";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DRIVE_API_PREFIXES = ["/api/notes", "/api/folders"];

export const SESSION_USER_HEADER = "X-MiyulabMD-Session-User";

export type ApiRequestOptions = {
  /** Captured caller identity: undefined is unchecked; null explicitly expects guest. */
  viewerId?: string | null;
};

/** A local publication rejection, not an HTTP denial or communication failure. */
export class ApiIdentityError extends Error {
  readonly status: number;
  readonly expectedViewerId: string | null;

  constructor(status: number, expectedViewerId: string | null) {
    super("API response session identity did not match the expected viewer");
    this.name = "ApiIdentityError";
    this.status = status;
    this.expectedViewerId = expectedViewerId;
  }
}

const identityListeners = new Set<(error: ApiIdentityError) => void>();

/** A re-verification hint only; response headers never establish an auth user. */
export function subscribeApiIdentityChange(
  listener: (error: ApiIdentityError) => void,
): () => void {
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
}

function notifyIdentityChange(error: ApiIdentityError): void {
  for (const listener of [...identityListeners]) {
    try {
      listener(error);
    } catch {
      // An observer cannot replace the request's identity failure.
    }
  }
}

export function requestSignal(
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | null | undefined {
  if (init?.signal !== undefined) {
    return init.signal;
  }
  return typeof Request !== "undefined" && input instanceof Request
    ? input.signal
    : undefined;
}

function discardResponse(response: Response): void {
  // Disposal must not replace the identity/cancellation reason or delay rejection.
  void response.body?.cancel().catch(() => {
    // Best effort: a broken body does not authorize its response.
  });
}

function assertResponseIdentity(
  response: Response,
  viewerId: string | null | undefined,
): void {
  if (viewerId === undefined) {
    return;
  }
  const actual = response.headers.get(SESSION_USER_HEADER);
  const expected = viewerId === null ? "guest" : `user:${viewerId}`;
  if (
    actual === null ||
    !/^(guest|user:[^\s,]+)$/.test(actual) ||
    actual !== expected
  ) {
    discardResponse(response);
    const error = new ApiIdentityError(response.status, viewerId);
    notifyIdentityChange(error);
    throw error;
  }
}

function isDriveMutation(input: RequestInfo | URL, method: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  let requestUrl: string | URL;
  if (typeof Request !== "undefined" && input instanceof Request) {
    requestUrl = input.url;
  } else if (input instanceof URL) {
    requestUrl = input.href;
  } else {
    requestUrl = input as string | URL;
  }
  let url: URL;
  try {
    url = new URL(requestUrl, window.location.href);
  } catch {
    return false;
  }
  return (
    url.origin === window.location.origin &&
    DRIVE_API_PREFIXES.some(
      (prefix) =>
        url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    ) &&
    !READ_METHODS.has(method)
  );
}

export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const viewerId = options.viewerId;
  const signal = requestSignal(input, init);
  const method =
    init?.method?.toUpperCase() ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.method.toUpperCase()
      : "GET");
  const send = async () => {
    if (signal?.aborted) {
      throw signal.reason;
    }
    let result: Response;
    try {
      result = await globalThis.fetch(input, init);
    } catch (error) {
      throw signal?.aborted ? signal.reason : error;
    }
    if (signal?.aborted) {
      discardResponse(result);
      throw signal.reason;
    }
    assertResponseIdentity(result, viewerId);
    return result;
  };
  const response = READ_METHODS.has(method) ? send() : runMutation(send);
  if (!isDriveMutation(input, method)) {
    return response;
  }
  return response.then((result) => {
    if (result.status >= 200 && result.status < 300 && !result.redirected) {
      notifyDriveChanged();
    }
    return result;
  });
}
