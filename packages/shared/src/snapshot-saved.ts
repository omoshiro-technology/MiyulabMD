/** Extension to y-websocket; standard sync/awareness/auth types stay untouched. */
export const MESSAGE_SNAPSHOT_SAVED = 4;
export const SNAPSHOT_SAVED_VERSION = 1;

/** No document content, revision, user identity or authorization data. */
export function encodeSnapshotSaved(noteId: string): Uint8Array {
  return new Uint8Array([
    MESSAGE_SNAPSHOT_SAVED,
    SNAPSHOT_SAVED_VERSION,
    ...new TextEncoder().encode(noteId),
  ]);
}

/** Payload after the y-websocket top-level type has been consumed. */
export function isSnapshotSavedForRoom(
  payload: Uint8Array,
  noteId: string,
): boolean {
  if (
    payload[0] !== SNAPSHOT_SAVED_VERSION ||
    payload.length < 2 ||
    payload.length > 257 ||
    !noteId
  ) {
    return false;
  }
  try {
    return (
      new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(1)) ===
      noteId
    );
  } catch {
    return false;
  }
}
