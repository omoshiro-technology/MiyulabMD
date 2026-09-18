/** Hold the next native open's delivery after HTTP transport has settled. */
export function deferNextDatabaseOpen() {
  const originalOpen = IDBFactory.prototype.open;
  const success = Object.getOwnPropertyDescriptor(
    IDBRequest.prototype,
    "onsuccess",
  );
  if (!success?.set) {
    throw new Error("Native IndexedDB success boundary unavailable");
  }
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let intercepted = false;
  IDBFactory.prototype.open = function (
    this: IDBFactory,
    ...args: Parameters<IDBFactory["open"]>
  ) {
    const request = originalOpen.apply(this, args);
    if (!intercepted) {
      intercepted = true;
      Object.defineProperty(request, "onsuccess", {
        set(handler: ((event: Event) => void) | null) {
          if (!handler) {
            success.set?.call(request, handler);
            return;
          }
          success.set?.call(request, (event: Event) => {
            started.resolve();
            void released.promise.then(() => handler.call(request, event));
          });
        },
      });
    }
    return request;
  };
  return {
    release: () => released.resolve(),
    restore: () => {
      IDBFactory.prototype.open = originalOpen;
      released.resolve();
    },
    started: started.promise,
  };
}
