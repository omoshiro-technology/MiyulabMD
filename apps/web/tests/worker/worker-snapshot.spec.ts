import { encodeSnapshotSaved, MESSAGE_SNAPSHOT_SAVED } from "@miyulabmd/shared";
import { expect, test } from "@playwright/test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";

test("real Worker alarm projects a WebSocket Yjs edit to D1 after debounce", async ({
  page,
  context,
  baseURL,
}) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/auth/login?email=worker-snapshot%40example.test");
  await page.waitForURL(`${baseURL}/`);
  const initial = "# Before alarm\n\nOriginal snapshot";
  const markdown = "# After alarm\n\nPersisted only through a Yjs update.";
  const created = await context.request.post("/api/notes", {
    data: { markdown: initial, permission: "private" },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const doc = new Y.Doc();
  try {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    sync.writeSyncStep1(encoder, doc);
    // Browser WebSocket carries the real HttpOnly login cookie. Keep this
    // socket open for the edit; no editor bundle or API mutation does the work.
    const frame = await page.evaluate(
      ({ id, request, savedType }) =>
        new Promise<number[]>((resolve, reject) => {
          const socket = new WebSocket(
            `${location.origin.replace("http", "ws")}/ws/notes/${id}`,
          );
          Object.assign(window, { snapshotSocket: socket });
          Object.assign(window, { savedFrames: [] });
          socket.binaryType = "arraybuffer";
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("Yjs initial sync timed out"));
          }, 10_000);
          socket.onopen = () => socket.send(new Uint8Array(request));
          socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error("Authenticated snapshot WebSocket failed"));
          };
          socket.onmessage = (event) => {
            const bytes = new Uint8Array(event.data);
            if (bytes[0] === savedType) {
              (window as Window & { savedFrames: number[][] }).savedFrames.push(
                Array.from(bytes),
              );
            }
            // Standard y-websocket sync / sync-step-2, not awareness.
            if (bytes[0] === 0 && bytes[1] === 1) {
              clearTimeout(timer);
              resolve(Array.from(bytes));
            }
          };
        }),
      {
        id,
        request: Array.from(encoding.toUint8Array(encoder)) as number[],
        savedType: MESSAGE_SNAPSHOT_SAVED,
      },
    );
    const decoder = decoding.createDecoder(new Uint8Array(frame));
    expect(decoding.readVarUint(decoder)).toBe(0);
    expect(
      sync.readSyncMessage(decoder, encoding.createEncoder(), doc, "server"),
    ).toBe(sync.messageYjsSyncStep2);
    expect(doc.getText("markdown").toString()).toBe(initial);
    const state = Y.encodeStateVector(doc);
    doc.transact(() => {
      const text = doc.getText("markdown");
      text.delete(0, text.length);
      text.insert(0, markdown);
    });
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 0);
    sync.writeUpdate(update, Y.encodeStateAsUpdate(doc, state));
    const sentAt = Date.now();
    await page.evaluate(
      (bytes) => {
        const socket = (window as Window & { snapshotSocket: WebSocket })
          .snapshotSocket;
        socket.send(new Uint8Array(bytes));
      },
      Array.from(encoding.toUint8Array(update)) as number[],
    );
    const immediate = await context.request.get(`/api/notes/${id}`);
    expect(immediate.status()).toBe(200);
    expect(await immediate.json()).toMatchObject({
      markdown: initial,
      title: "Before alarm",
    });
    expect(
      await page.evaluate(
        () => (window as Window & { savedFrames: number[][] }).savedFrames,
      ),
    ).toEqual([]);
    await expect
      .poll(
        async () => {
          const response = await context.request.get(`/api/notes/${id}`);
          expect(response.status()).toBe(200);
          const note = await response.json();
          return { markdown: note.markdown, title: note.title };
        },
        { intervals: [100, 250, 500], timeout: 20_000 },
      )
      .toEqual({ markdown, title: "After alarm" });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { savedFrames: number[][] }).savedFrames,
        ),
      )
      .toEqual([Array.from(encodeSnapshotSaved(id))]);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(3000);
  } finally {
    await page.evaluate(() => {
      (
        window as Window & { snapshotSocket?: WebSocket }
      ).snapshotSocket?.close();
    });
    doc.destroy();
  }
});
