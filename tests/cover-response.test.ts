import assert from "node:assert/strict";
import test from "node:test";
import { cancelUnreadCoverResponse, readCoverImageResponse } from "../src/cover-response.js";

const errors = {
  http: (status: number) => new Error(`HTTP ${status}`),
  contentType: () => new Error("not an image"),
  tooLarge: () => new Error("image too large"),
};

function trackedResponse(options: {
  status?: number;
  contentType?: string;
  contentLength?: string;
  chunks?: Uint8Array[];
  close?: boolean;
  cancelError?: Error;
} = {}) {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of options.chunks ?? []) controller.enqueue(chunk);
      if (options.close) controller.close();
    },
    cancel() {
      cancellations += 1;
      if (options.cancelError) throw options.cancelError;
    },
  });
  const headers = new Headers();
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  const response = new Response(body, { status: options.status ?? 200, headers });
  return { response, cancellations: () => cancellations };
}

test("a complete image is read without cancellation and its reader is released", async () => {
  const input = trackedResponse({
    contentType: "image/jpeg; charset=binary",
    chunks: [Uint8Array.of(1, 2), Uint8Array.of(3)],
    close: true,
  });
  const bytes = await readCoverImageResponse(input.response, 3, errors);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(input.cancellations(), 0);
  assert.equal(input.response.body?.locked, false);
});

test("HTTP errors, invalid images and declared oversize cancel unread bodies", async () => {
  const cases = [
    { options: { status: 503 }, message: /HTTP 503/ },
    { options: { contentType: "text/html" }, message: /not an image/ },
    { options: { contentType: "image/jpeg", contentLength: "4" }, message: /image too large/ },
  ];
  for (const entry of cases) {
    const input = trackedResponse(entry.options);
    await assert.rejects(readCoverImageResponse(input.response, 3, errors), entry.message);
    assert.equal(input.cancellations(), 1);
    assert.equal(input.response.body?.locked, false);
  }
});

test("streaming oversize cancels the reader once and keeps the original error", async () => {
  const input = trackedResponse({ contentType: "image/png", chunks: [Uint8Array.of(1, 2, 3, 4)] });
  await assert.rejects(readCoverImageResponse(input.response, 3, errors), /image too large/);
  assert.equal(input.cancellations(), 1);
  assert.equal(input.response.body?.locked, false);
});

test("redirect body cancellation is idempotent", async () => {
  const input = trackedResponse({ status: 302 });
  await cancelUnreadCoverResponse(input.response);
  await cancelUnreadCoverResponse(input.response);
  assert.equal(input.cancellations(), 1);
  assert.equal(input.response.body?.locked, false);
});

test("a cleanup failure does not replace the HTTP error", async (context) => {
  context.mock.method(console, "debug", () => {});
  const input = trackedResponse({ status: 500, cancelError: new Error("cleanup failed") });
  await assert.rejects(readCoverImageResponse(input.response, 3, errors), /HTTP 500/);
  assert.equal(input.cancellations(), 1);
});

test("an interrupted response keeps the read error and releases the reader", async (context) => {
  context.mock.method(console, "debug", () => {});
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new DOMException("download timed out", "AbortError")); },
  });
  const response = new Response(body, { headers: { "content-type": "image/png" } });
  await assert.rejects(readCoverImageResponse(response, 3, errors), /download timed out/);
  assert.equal(response.body?.locked, false);
});
