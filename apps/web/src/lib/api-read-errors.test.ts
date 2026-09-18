import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, mock, test } from "node:test";
import { fetchAuthConfig, fetchMe, fetchNote } from "./api.ts";

afterEach(() => mock.restoreAll());

test("read APIs distinguish communication failures from malformed JSON", async () => {
  const readers = [
    { name: "note", read: () => fetchNote("note-1") },
    { name: "viewer", read: fetchMe },
    { name: "auth config", read: fetchAuthConfig },
  ];
  const transportFailure = new TypeError("Connection lost before headers");
  const bodyFailure = new TypeError("Connection lost during response body");
  const fetchMock = mock.method(globalThis, "fetch", () =>
    Promise.reject(transportFailure),
  );

  for (const { name, read } of readers) {
    fetchMock.mock.mockImplementation(() => Promise.reject(transportFailure));
    await assert.rejects(
      read,
      { cause: transportFailure, name: "ApiCommunicationError" },
      `${name}: a rejected fetch is a communication failure`,
    );

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(bodyFailure);
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    await assert.rejects(
      read,
      { cause: bodyFailure, name: "ApiCommunicationError" },
      `${name}: a failed response stream is a communication failure`,
    );

    fetchMock.mock.mockImplementation(() =>
      Promise.resolve(
        new Response('{"broken":', {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await assert.rejects(
      read,
      { name: "SyntaxError" },
      `${name}: invalid JSON must not be treated as a communication failure`,
    );
  }
});

test("read APIs preserve cancellation and unexpected failures without cache-fallback classification", async () => {
  const readers = [
    { name: "note", read: () => fetchNote("note-1") },
    { name: "viewer", read: fetchMe },
    { name: "auth config", read: fetchAuthConfig },
  ];
  const failures = [
    new DOMException("Viewer changed", "AbortError"),
    new Error("Unexpected transport implementation failure"),
  ];
  const fetchMock = mock.method(globalThis, "fetch", () =>
    Promise.reject(failures[0]),
  );

  for (const { name, read } of readers) {
    for (const failure of failures) {
      fetchMock.mock.mockImplementation(() => Promise.reject(failure));
      await assert.rejects(
        read,
        (error) => error === failure,
        `${name}: fetch cancellation and unknown failures retain their identity`,
      );

      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
          ),
        ),
      );
      await assert.rejects(
        read,
        (error) => error === failure,
        `${name}: body cancellation and unknown failures retain their identity`,
      );
    }
  }
});

test("request cancellation preserves custom reasons and native signal inheritance", async () => {
  const modulePath = "./api-transport.ts";
  const { requestJson } = await import(modulePath);
  const controller = new AbortController();
  const reason = new TypeError("Cancelled because the viewer changed");
  controller.abort(reason);
  // These requests are already aborted: native fetch performs no network I/O.
  const url = "https://example.invalid/";
  await assert.rejects(
    () => requestJson(url, { signal: controller.signal }),
    (error) => error === reason,
  );
  await assert.rejects(
    () => requestJson(new Request(url, { signal: controller.signal })),
    (error) => error === reason,
  );
  await assert.rejects(
    () =>
      requestJson(new Request(url, { signal: controller.signal }), {
        signal: undefined,
      }),
    (error) => error === reason,
    "undefined inherits the aborted Request signal rather than clearing it",
  );

  const transportFailure = new TypeError("Connection failed, not cancelled");
  mock.method(globalThis, "fetch", () => Promise.reject(transportFailure));
  await assert.rejects(
    () =>
      requestJson(new Request(url, { signal: controller.signal }), {
        signal: null,
      }),
    { cause: transportFailure, name: "ApiCommunicationError" },
    "an explicit null signal overrides the aborted Request signal",
  );
});

test("a request retains its cancellation context after response headers arrive", {
  timeout: 10_000,
}, async (t) => {
  const modulePath = "./api-transport.ts";
  const { requestJson } = await import(modulePath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"pending":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  // Observe the network boundary, not the decoder's choice of text() / json().
  const headersReceived = Promise.withResolvers<void>();
  const nativeFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (...args) => {
    const response = await nativeFetch(...args);
    headersReceived.resolve();
    return response;
  });

  const controller = new AbortController();
  const reason = new TypeError("Viewer changed while receiving the body");
  const pending = requestJson(`http://127.0.0.1:${address.port}/`, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await headersReceived.promise;
  controller.abort(reason);
  await rejected;
});

test("all 4xx and 5xx note responses retain their HTTP status when the error body is unavailable", async () => {
  const fetchMock = mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response()),
  );
  for (let status = 400; status <= 599; status += 1) {
    const statusText = `HTTP ${status}`;
    const responseOptions = { status, statusText };
    for (const malformed of [false, true]) {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve(
          malformed
            ? new Response("<html>Not JSON</html>", responseOptions)
            : new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(
                      new TypeError("Error body connection lost"),
                    );
                  },
                }),
                responseOptions,
              ),
        ),
      );
      assert.deepEqual(await fetchNote("note-1"), {
        error: statusText,
        ok: false,
        status,
      });
    }
  }
});
