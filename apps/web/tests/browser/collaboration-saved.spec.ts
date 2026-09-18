import { encodeSnapshotSaved, MESSAGE_SNAPSHOT_SAVED } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";

test("only a server-confirmed room save dispatches the public payload-free drive event", async ({
  page,
}) => {
  let socket: import("@playwright/test").WebSocketRoute | undefined;
  await page.routeWebSocket("**/ws/notes/saved-room", (ws) => {
    socket = ws;
  });
  await page.goto("/tests/browser/fixtures/storage.html");
  await page.evaluate(async () => {
    const { createYjsSession } = await import("/src/lib/collaboration.ts");
    const { DRIVE_CHANGED_EVENT } = await import("/src/lib/drive-changed.ts");
    const events: boolean[] = [];
    window.addEventListener(DRIVE_CHANGED_EVENT, (event) => {
      events.push(!("detail" in event));
    });
    const session = createYjsSession("saved-room", null);
    Object.assign(window, { savedEvents: events, savedSession: session });
    session.yMarkdown.insert(0, "Local typing is not saved");
  });
  await expect.poll(() => Boolean(socket)).toBe(true);
  const events = () =>
    page.evaluate(
      () => (window as Window & { savedEvents: boolean[] }).savedEvents,
    );
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, "Remote Yjs update is not saved");
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 0);
  sync.writeUpdate(update, Y.encodeStateAsUpdate(doc));
  socket?.send(Buffer.from(encoding.toUint8Array(update)));
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & {
            savedSession: { yMarkdown: { toString(): string } };
          }
        ).savedSession.yMarkdown.toString(),
      ),
    )
    .toContain("Remote Yjs update is not saved");
  doc.destroy();
  expect(await events()).toEqual([]);
  socket?.send(Buffer.from(encodeSnapshotSaved("saved-room")));
  await expect.poll(events).toEqual([true]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const frame of [
    encodeSnapshotSaved("another-room"),
    new Uint8Array([MESSAGE_SNAPSHOT_SAVED]),
    new Uint8Array([MESSAGE_SNAPSHOT_SAVED, 99, 65]),
    new Uint8Array([MESSAGE_SNAPSHOT_SAVED, 1, 0xff]),
    new Uint8Array([...encodeSnapshotSaved("saved-room"), 0]),
  ]) {
    socket?.send(Buffer.from(frame));
  }
  // A subsequent valid frame is a processing barrier: malformed frames neither
  // notified nor broke the WebSocket session.
  socket?.send(Buffer.from(encodeSnapshotSaved("saved-room")));
  await expect.poll(events).toEqual([true, true]);
  expect(errors).toEqual([]);
  await page.evaluate(
    (frame) => {
      const session = (
        window as Window & {
          savedSession: { destroy(): void; provider: { ws: WebSocket | null } };
        }
      ).savedSession;
      const ws = session.provider.ws;
      const queued = ws?.onmessage;
      session.destroy();
      // Simulate a message already queued when disposal detached the provider.
      if (ws) {
        queued?.call(
          ws,
          new MessageEvent("message", { data: new Uint8Array(frame).buffer }),
        );
      }
    },
    Array.from(encodeSnapshotSaved("saved-room")),
  );
  expect(await events()).toEqual([true, true]);
  expect(errors).toEqual([]);
});
