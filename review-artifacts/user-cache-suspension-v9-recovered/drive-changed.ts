export const DRIVE_CHANGED_EVENT = "miyulabmd:drive-changed";

export function notifyDriveChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(DRIVE_CHANGED_EVENT));
}

export function onDriveChanged(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener(DRIVE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DRIVE_CHANGED_EVENT, listener);
}
