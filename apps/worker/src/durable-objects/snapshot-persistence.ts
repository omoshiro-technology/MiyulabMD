export const STORAGE_YJS_KEY = "yjs-update";
const PENDING_KEY = "snapshot-pending";
const DEBOUNCE_MS = 3000;
const RETRY_MS = 30_000;

type PendingSnapshot = { revision: string; markdown: string };
export type SnapshotTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};
export type SnapshotStorage = SnapshotTransaction & {
  transaction<T>(run: (txn: SnapshotTransaction) => Promise<T>): Promise<T>;
};

/** Durable outbox: Yjs state, its markdown projection and wakeup commit together. */
export class SnapshotPersistence {
  private readonly storage: SnapshotStorage;
  private readonly write: (markdown: string) => Promise<void>;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    storage: SnapshotStorage,
    write: (markdown: string) => Promise<void>,
  ) {
    this.storage = storage;
    this.write = write;
  }

  async persist(update: Uint8Array, markdown: string): Promise<void> {
    const pending: PendingSnapshot = {
      markdown,
      revision: crypto.randomUUID(),
    };
    await this.storage.transaction(async (txn) => {
      await txn.put(STORAGE_YJS_KEY, update);
      await txn.put(PENDING_KEY, pending);
      await txn.setAlarm(Date.now() + DEBOUNCE_MS);
    });
  }

  flush(): Promise<void> {
    // Task RPCs and alarm delivery can overlap while a D1 request is in flight.
    const next = this.flushing.then(() => this.flushPending());
    this.flushing = next.catch(() => undefined);
    return next;
  }

  private async flushPending(): Promise<void> {
    const pending = await this.storage.transaction(async (txn) => {
      const value = await txn.get<PendingSnapshot>(PENDING_KEY);
      // Rearm before external I/O: failure or actor loss must not strand work.
      if (value) {
        await txn.setAlarm(Date.now() + RETRY_MS);
      }
      return value;
    });
    if (!pending) {
      return;
    }
    await this.write(pending.markdown);
    await this.storage.transaction(async (txn) => {
      const current = await txn.get<PendingSnapshot>(PENDING_KEY);
      if (current?.revision !== pending.revision) {
        return;
      }
      await txn.delete(PENDING_KEY);
      await txn.deleteAlarm();
    });
  }
}
