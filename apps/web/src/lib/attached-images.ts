import { apiFetch } from "./api-fetch.ts";
import { type AttachedImage, attachedImage } from "./attached-image-target.ts";
import {
  isSupportedCachedImageMime,
  openOfflineCache,
} from "./offline-cache.ts";
import type { StorageWriteRecovery } from "./storage-write-recovery.ts";

export {
  type AttachedImage,
  attachedImage,
  collectAttachedImages,
} from "./attached-image-target.ts";

type Options = {
  userId: string;
  cacheOnly: boolean;
  requireCache?: boolean;
  signal?: AbortSignal;
  storageRecovery?: StorageWriteRecovery;
};
type CacheFailure = {
  error: unknown;
  retry(signal: AbortSignal): Promise<void>;
};
type LoadedImage = {
  bytes: Blob | null;
  cacheFailure?: CacheFailure;
};
type Entry = {
  controller: AbortController;
  promise: Promise<LoadedImage>;
  users: number;
};
const inFlight = new Map<string, Entry>();
type ImageCache = Awaited<ReturnType<typeof openOfflineCache>>;

export class AttachedImageCacheError extends Error {
  cause: unknown;

  constructor(cause: unknown) {
    super("Attached image cache write failed");
    this.cause = cause;
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason;
  }
}

async function writeImageToFreshCache(
  image: AttachedImage,
  bytes: Blob,
  userId: string,
  orderingToken: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  const cache = await openOfflineCache({ signal, userId });
  try {
    const token =
      orderingToken ??
      (await cache.beginImageRead(image.noteId, image.imageId));
    await cache.putImage(image.noteId, image.imageId, bytes, {
      orderingToken: token,
      signal,
    });
  } finally {
    cache.close();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: network status, durable denial, and optional cache fallback have separate semantics.
async function readNetworkImage(
  image: AttachedImage,
  cache: ImageCache | null,
  cacheOpenError: unknown,
  userId: string,
  signal?: AbortSignal,
): Promise<LoadedImage> {
  const orderingToken = cache
    ? await cache.beginImageRead(image.noteId, image.imageId)
    : undefined;
  const response = await apiFetch(
    image.url,
    {
      cache: "no-store",
      credentials: "include",
      redirect: "error",
      signal,
    },
    { viewerId: userId },
  );
  checkAbort(signal);
  if ([401, 403, 404].includes(response.status)) {
    // A definitive image denial must never turn into a stale image fallback.
    try {
      if (!cache) {
        throw new Error("Image denial storage unavailable");
      }
      await cache.denyImage(image.noteId, image.imageId, orderingToken);
    } catch {
      // The denial marker is best-effort for images: a failed write is a
      // warning-class event, never a reason to suspend display reads.
    }
    return { bytes: null };
  }
  if (response.status >= 500 && response.status <= 599) {
    return {
      bytes: cache ? await cache.getImage(image.noteId, image.imageId) : null,
    };
  }
  if (!response.ok || response.redirected) {
    return { bytes: null };
  }
  const mime =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  if (!isSupportedCachedImageMime(mime)) {
    return { bytes: null };
  }
  const bytes = new Blob([await response.blob()], { type: mime });
  checkAbort(signal);
  const retry = (retrySignal: AbortSignal) =>
    writeImageToFreshCache(image, bytes, userId, orderingToken, retrySignal);
  if (!cache) {
    return {
      bytes,
      cacheFailure: {
        error: cacheOpenError ?? new Error("Image cache storage unavailable"),
        retry,
      },
    };
  }
  try {
    await cache.putImage(image.noteId, image.imageId, bytes, {
      orderingToken,
      signal,
    });
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === "AbortError") {
      return { bytes: null };
    }
    // Failed replacements leave the old committed reference intact.
    return { bytes, cacheFailure: { error, retry } };
  }
  return { bytes };
}

async function loadImage(
  image: AttachedImage,
  options: Options,
): Promise<LoadedImage> {
  const { userId, signal, cacheOnly } = options;
  checkAbort(signal);
  let cache: ImageCache | null = null;
  let cacheOpenError: unknown;
  try {
    try {
      cache = await openOfflineCache({ signal, userId });
    } catch (error) {
      checkAbort(signal);
      cacheOpenError = error;
      // A healthy online image does not depend on optional local storage.
    }
    if (cacheOnly) {
      return {
        bytes: cache ? await cache.getImage(image.noteId, image.imageId) : null,
      };
    }
    try {
      return await readNetworkImage(
        image,
        cache,
        cacheOpenError,
        userId,
        signal,
      );
    } catch (error) {
      checkAbort(signal);
      if (!(error instanceof TypeError)) {
        throw error;
      }
      return {
        bytes: cache ? await cache.getImage(image.noteId, image.imageId) : null,
      };
    }
  } finally {
    cache?.close();
  }
}

/** One acquisition for foreground and prefetch; cancellation belongs to each consumer. */
export async function acquireAttachedImage(
  image: AttachedImage,
  options: Options,
): Promise<Blob | null> {
  const {
    userId,
    signal = new AbortController().signal,
    cacheOnly,
    requireCache,
    storageRecovery,
  } = options;
  checkAbort(signal);
  const target = attachedImage(image.url);
  if (
    !target ||
    target.noteId !== image.noteId ||
    target.imageId !== image.imageId
  ) {
    return null;
  }
  const key = JSON.stringify([userId, cacheOnly, image.url]);
  let entry = inFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      promise: loadImage(image, {
        cacheOnly,
        signal: controller.signal,
        userId,
      }),
      users: 0,
    };
    inFlight.set(key, entry);
    const current = entry;
    const remove = () => {
      if (inFlight.get(key) === current) {
        inFlight.delete(key);
      }
    };
    void entry.promise.then(remove, remove);
  }
  const current = entry;
  current.users += 1;
  const loaded = await new Promise<LoadedImage>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return false;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
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
        reject(signal?.reason);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    void current.promise.then(
      (value) => {
        if (cleanup()) {
          resolve(value);
        }
      },
      (error) => {
        if (cleanup()) {
          reject(error);
        }
      },
    );
    if (signal?.aborted) {
      abort();
    }
  });
  checkAbort(signal);
  if (requireCache && loaded.cacheFailure) {
    try {
      if (!storageRecovery) {
        throw loaded.cacheFailure.error;
      }
      await storageRecovery.recover(
        loaded.cacheFailure.error,
        () => loaded.cacheFailure?.retry(signal) ?? Promise.resolve(),
        signal,
      );
    } catch (error) {
      checkAbort(signal);
      throw new AttachedImageCacheError(error);
    }
  }
  return loaded.bytes;
}
