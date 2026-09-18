import { encodeSnapshotSaved } from "@miyulabmd/shared";

/**
 * Final outcome of the D1 writer.
 * - "persisted": the commit succeeded; subscribers may be notified.
 * - "rejected": a definitive refusal (gold lock, deleted note). The outbox
 *   drops the pending snapshot without a saved hint and without retrying.
 * Throw from the writer instead when the failure is transient and the
 * pending snapshot must be retried by the alarm.
 */
export type SnapshotWriteResult = "persisted" | "rejected";

/** A save hint is best-effort, and strictly follows a persisted D1 write. */
export async function writeSnapshotAndNotify(
  write: () => Promise<SnapshotWriteResult>,
  noteId: string,
  subscribers: () => Iterable<{ send(frame: Uint8Array): void }>,
): Promise<SnapshotWriteResult> {
  const result = await write();
  if (result !== "persisted") {
    return result;
  }
  const payload = encodeSnapshotSaved(noteId);
  for (const socket of subscribers()) {
    try {
      socket.send(payload);
    } catch {
      // Disconnection cannot turn successful persistence into a write retry.
    }
  }
  return result;
}
