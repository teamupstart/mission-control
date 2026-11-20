// The egress helpers' byte accounting and redirect policy, against in-memory responses: no network.
import assert from "node:assert/strict";
import test from "node:test";
import { cappedFetch, ResponseCapError } from "../src/server/origin-fetch.ts";

const CAP = 64;

/** A fetch answering with these chunks as one event stream, or as another content type. */
function answering(chunks: string[], init: { status?: number; type?: string } = {}) {
  return async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/event-stream" } });
}

/**
 * Read the capped body. An accepted stream must arrive whole, exactly as sent; a refused one must
 * fail to read with `ResponseCapError` and report it to `onOverflow`. Anything else fails the test.
 */
async function read(chunks: string[], init?: { status?: number; type?: string }): Promise<{ overflow: boolean }> {
  let reported = false;
  const response = await cappedFetch(answering(chunks, init), CAP, (error) => { reported = error instanceof ResponseCapError; })("http://127.0.0.1/");
  try {
    const text = await response.text();
    assert.equal(reported, false, "an accepted stream reported no overflow");
    assert.equal(text, chunks.join(""), "an accepted stream arrives whole");
    return { overflow: false };
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.ok(error instanceof ResponseCapError, `a refused stream fails with the cap error, not ${String(error)}`);
    assert.equal(reported, true, "and reports it");
    return { overflow: true };
  }
}

/** One event of exactly `bytes` bytes, its CRLF blank line included. */
function event(bytes: number): string {
  return `data: ${"x".repeat(bytes - 10)}\r\n\r\n`;
}

test("the LF that ends an event's CRLF blank line counts toward that event, not the next", async () => {
  assert.equal(event(CAP).length, CAP);
  assert.equal((await read([event(CAP)])).overflow, false, "an event exactly at the cap is read");
  assert.equal((await read([event(CAP + 1)])).overflow, true, "one byte over is refused, even when that byte is the final LF");
  assert.equal((await read([event(20), event(CAP)])).overflow, false, "an event at the cap after another is not charged its LF");
});

test("a CRLF split across two chunks is counted the same way", async () => {
  const over = event(CAP + 1);
  assert.equal((await read([over.slice(0, -1), over.slice(-1)])).overflow, true);
  const first = event(20);
  assert.equal((await read([first.slice(0, -1), first.slice(-1) + event(CAP)])).overflow, false);
});

test("a blank line between events belongs to no event, so it is not charged to the next one", async () => {
  const lfEvent = (bytes: number) => `data: ${"x".repeat(bytes - 8)}\n\n`;
  assert.equal(lfEvent(CAP).length, CAP);
  assert.equal((await read([lfEvent(20), "\n", lfEvent(CAP)])).overflow, false, "an extra LF before an event at the cap");
  assert.equal((await read([event(20), "\r\n\r\n", event(CAP)])).overflow, false, "extra CRLF lines before an event at the cap");
  assert.equal((await read(["\n\n", lfEvent(CAP)])).overflow, false, "blank lines at the start of the stream");
  assert.equal((await read([lfEvent(20), "\n", lfEvent(CAP + 1)])).overflow, true, "and the event itself is still capped");
});

test("a response that is not a success is capped as a whole body, even as an event stream", async () => {
  const small = Array.from({ length: 10 }, () => "data: x\n\n").join("");
  assert.equal((await read([small], { status: 500 })).overflow, true, "100 bytes of 10-byte events over a 64-byte cap");
  assert.equal((await read([small], { status: 200 })).overflow, false, "the same events on a success are each under the cap");
});
