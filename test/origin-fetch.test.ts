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

/** Whether reading the capped body overflowed, and what reached the reader. */
async function read(chunks: string[], init?: { status?: number; type?: string }): Promise<{ overflow: boolean; text: string }> {
  let overflow = false;
  const response = await cappedFetch(answering(chunks, init), CAP, (error) => { overflow = error instanceof ResponseCapError; })("http://127.0.0.1/");
  try {
    return { overflow, text: await response.text() };
  } catch {
    return { overflow, text: "" };
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

test("a response that is not a success is capped as a whole body, even as an event stream", async () => {
  const small = Array.from({ length: 10 }, () => "data: x\n\n").join("");
  assert.equal((await read([small], { status: 500 })).overflow, true, "100 bytes of 10-byte events over a 64-byte cap");
  assert.equal((await read([small], { status: 200 })).overflow, false, "the same events on a success are each under the cap");
});
