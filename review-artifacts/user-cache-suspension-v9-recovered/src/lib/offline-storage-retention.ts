export type OfflineStorageEstimate = {
  usage: number;
  quota: number;
  available: number;
};

let persistenceRequest: Promise<boolean | undefined> | undefined;
let latestEstimate: OfflineStorageEstimate | null = null;

/** A browser may deny retention or evict data anyway; this is not permission. */
export function requestOfflineStoragePersistence(): Promise<
  boolean | undefined
> {
  persistenceRequest ??= (async () => {
    try {
      return await navigator.storage?.persist?.();
    } catch {
      // Unsupported or rejected retention is not a cache or auth failure.
    }
  })();
  return persistenceRequest;
}

/** Origin-wide approximate bytes, never a per-user budget or a write gate. */
export async function estimateOfflineStorage(): Promise<OfflineStorageEstimate | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const usage = estimate?.usage;
    const quota = estimate?.quota;
    latestEstimate =
      typeof usage === "number" &&
      typeof quota === "number" &&
      Number.isFinite(usage) &&
      Number.isFinite(quota) &&
      usage >= 0 &&
      quota >= 0
        ? { available: Math.max(0, quota - usage), quota, usage }
        : null;
  } catch {
    latestEstimate = null;
  }
  return getOfflineStorageEstimate();
}

export function getOfflineStorageEstimate(): OfflineStorageEstimate | null {
  return latestEstimate ? { ...latestEstimate } : null;
}
