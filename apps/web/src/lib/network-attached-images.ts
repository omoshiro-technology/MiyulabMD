import { apiFetch } from "./api-fetch.ts";
import { ApiIdentityError } from "./api-transport.ts";
import { type AttachedImage, attachedImage } from "./attached-image-target.ts";

type NetworkEntry = {
  controller: AbortController;
  promise: Promise<{ bytes: Blob | null }>;
  users: number;
};

const inFlight = new Map<string, NetworkEntry>();

// Keep this private: importing offline-cache here would make network-only load storage.
const supportedImageMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Blob | null> {
  if (
    response.redirected ||
    !response.ok ||
    response.status < 200 ||
    response.status >= 300
  ) {
    discard(response);
    return null;
  }
  const mime =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  if (!supportedImageMimes.has(mime)) {
    discard(response);
    return null;
  }
  const body = await response.blob();
  checkAbort(signal);
  return body.size === 0 ? null : new Blob([body], { type: mime });
}

/** Network-only attachment acquisition; this module has no cache/OPFS imports. */
export function acquireAttachedImageNetworkOnly(
  image: AttachedImage,
  options: { expectedViewerId: string | null; signal?: AbortSignal },
): Promise<Blob | null> {
  const { expectedViewerId, signal = new AbortController().signal } = options;
  checkAbort(signal);
  const target = attachedImage(image.url);
  if (
    !target ||
    target.noteId !== image.noteId ||
    target.imageId !== image.imageId
  ) {
    return Promise.resolve(null);
  }
  const key = JSON.stringify([expectedViewerId, image.url]);
  let entry = inFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      promise: (async () => {
        try {
          const response = await apiFetch(
            image.url,
            {
              cache: "no-store",
              credentials: "include",
              redirect: "error",
              signal: controller.signal,
            },
            { viewerId: expectedViewerId },
          );
          checkAbort(controller.signal);
          return { bytes: await readResponse(response, controller.signal) };
        } catch (error) {
          checkAbort(controller.signal);
          if (error instanceof TypeError || error instanceof ApiIdentityError) {
            return { bytes: null };
          }
          throw error;
        }
      })(),
      users: 0,
    };
    inFlight.set(key, entry);
    const current = entry;
    void entry.promise.then(
      () => {
        if (inFlight.get(key) === current) {
          inFlight.delete(key);
        }
      },
      () => {
        if (inFlight.get(key) === current) {
          inFlight.delete(key);
        }
      },
    );
  }
  const current = entry;
  current.users += 1;
  return new Promise<Blob | null>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return false;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      current.users -= 1;
      if (!current.users) {
        if (inFlight.get(key) === current) {
          inFlight.delete(key);
        }
        current.controller.abort();
      }
      return true;
    };
    const abort = () => {
      if (cleanup()) {
        reject(signal.reason);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    void current.promise.then(
      (value) => {
        if (cleanup()) {
          resolve(value.bytes);
        }
      },
      (error) => {
        if (cleanup()) {
          reject(error);
        }
      },
    );
    if (signal.aborted) {
      abort();
    }
  });
}
