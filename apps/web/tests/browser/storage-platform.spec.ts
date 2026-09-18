import { expect, test } from "@playwright/test";

test("IndexedDB and OPFS retain data across a page reload", async ({
  page,
}) => {
  await page.goto("/tests/browser/fixtures/storage.html");

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle("platform-check.txt", {
      create: true,
    });
    const writer = await file.createWritable();
    await writer.write("ブラウザ再読み込み後も読める本文");
    await writer.close();

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("platform-check", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("entries");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("entries", "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore("entries").put("platform-check.txt", "note");
      });
    } finally {
      db.close();
    }
  });

  await page.reload();

  const markdown = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("platform-check", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const filename = await new Promise<string>((resolve, reject) => {
        const request = db
          .transaction("entries")
          .objectStore("entries")
          .get("note");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(filename);
      return await (await file.getFile()).text();
    } finally {
      db.close();
    }
  });

  expect(markdown).toBe("ブラウザ再読み込み後も読める本文");
});
