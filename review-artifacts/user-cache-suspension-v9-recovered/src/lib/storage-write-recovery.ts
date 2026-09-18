import { collectOfflineCacheOrphans } from "./offline-cache.ts";

export type StorageWriteRecovery = {
  recover<T>(
    error: unknown,
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
};

export function isQuotaExceededError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

/** One recovery budget belongs to one acquisition cycle, not each file. */
export function createStorageWriteRecovery(
  userId: string,
): StorageWriteRecovery {
  let attempted = false;
  const recover = async <T>(
    error: unknown,
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    if (!isQuotaExceededError(error) || attempted) {
      throw error;
    }
    signal.throwIfAborted();
    attempted = true;
    // The failed public write has settled and released its shared lock.
    await collectOfflineCacheOrphans(userId);
    signal.throwIfAborted();
    return operation();
  };
  return {
    recover,
    async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        return recover(error, operation, signal);
      }
    },
  };
}
