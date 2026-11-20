// Egress helpers shared by everything that sends configured headers to a remote server: the
// resident MCP launcher's bridge, and task shaping's `http` and `mcp` transports. Deliberately
// importless, so the standalone launcher bundle still reaches nothing in the daemon's graph.
//
// Which URLs may carry credentials at all is `plaintextCredentialProblem` in
// `src/shared/resident-mcp.ts`: https, or plain http to this machine's loopback.

/** Redirects a request may follow before it gives up. */
const MAX_REDIRECTS = 5;

/**
 * Every request carries the configured headers and query values - and only to the configured
 * origin. Redirects are handled here rather than by `fetch`, which would follow one to another
 * origin with these headers attached: a redirect within the origin is followed with them, and
 * one that leaves it is refused, so no other host ever receives them. No cookie is ever kept.
 */
export async function fetchOnOrigin(
  origin: string,
  secretHeaders: Readonly<Record<string, string>>,
  input: string | URL | Request,
  init: RequestInit = {},
  secretQuery: URLSearchParams = new URLSearchParams(),
): Promise<Response> {
  let target = new URL(input instanceof Request ? input.url : String(input));
  let request: RequestInit = input instanceof Request
    ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, ...init }
    : { ...init };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.origin !== origin) {
      throw new Error("the server redirected to another origin, which never receives its headers");
    }
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(secretHeaders)) headers.set(name, value);
    // The configured query rides every request too, as exactly one value per name: an SSE
    // server names its own message endpoint, possibly with its own value for the parameter, and
    // a redirect may drop or change it, but the credential is the one configured for the server.
    for (const [name, value] of secretQuery) target.searchParams.set(name, value);
    const response = await fetch(target, { ...request, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    void response.body?.cancel().catch(() => {});
    target = new URL(location, target);
    // As a browser would: 303, and 301 or 302 after a POST, continue as a GET without a body.
    const method = (request.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const { body: _body, ...rest } = request;
      request = { ...rest, method: "GET" };
    }
  }
  throw new Error("the server redirected too many times");
}

/** Raised, and handed to `onOverflow`, when a response passes its cap while it is received. */
export class ResponseCapError extends Error {
  constructor(readonly capBytes: number) {
    super(`a message from the server was larger than ${Math.round(capBytes / 1024)} KiB`);
    this.name = "ResponseCapError";
  }
}

/**
 * A whole response body, read to at most `capBytes`. Reading stops at the byte that passes the
 * cap and the body is cancelled, so nothing past it is buffered or parsed.
 */
export async function readCappedBody(response: Response, capBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return { ok: true, bytes };
}

/** Whether a content type names an event stream, whose cap applies per event rather than per body. */
function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase() === "text/event-stream";
}

/**
 * A `fetch` whose every response body is capped while it is received: a JSON body at
 * `capBytes` in total, and an event stream at `capBytes` per event, counted from the blank line
 * that ends the one before it. At the byte that passes the cap the request is aborted, the body
 * errors with `ResponseCapError`, and `onOverflow` is told at once, so a caller waiting on a reply
 * that will never come does not wait for its deadline. Nothing past the cap reaches the reader.
 */
export function cappedFetch(
  base: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  capBytes: number,
  onOverflow: (error: ResponseCapError) => void,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const abort = new AbortController();
    const signals = [abort.signal, ...(init.signal ? [init.signal] : [])];
    const response = await base(input, { ...init, signal: AbortSignal.any(signals) });
    // A status that has no body by definition cannot be rebuilt with one.
    if (!response.body || [101, 204, 205, 304].includes(response.status)) return response;
    const perEvent = isEventStream(response.headers.get("content-type"));
    const source = response.body.getReader();
    let counted = 0;
    // An event ends at a blank line: two line ends in a row, where a line end is LF, CR or CRLF.
    let lastWasLineEnd = false;
    let lastWasCr = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try { read = await source.read(); } catch (error) { controller.error(error); return; }
        if (read.done) { controller.close(); return; }
        const chunk = read.value;
        if (!perEvent) {
          counted += chunk.byteLength;
        } else {
          for (const byte of chunk) {
            // Every byte on the wire counts, both bytes of a CRLF included: an event of many short
            // CRLF lines must not pass the cap while being counted as fewer bytes than it is.
            counted += 1;
            if (counted > capBytes) break;
            // The LF of a CRLF ends the same line its CR already ended.
            if (byte === 0x0a && lastWasCr) { lastWasCr = false; continue; }
            const lineEnd = byte === 0x0a || byte === 0x0d;
            lastWasCr = byte === 0x0d;
            // A line end right after another is the blank line that ends the event.
            if (lineEnd && lastWasLineEnd) { counted = 0; lastWasLineEnd = false; continue; }
            lastWasLineEnd = lineEnd;
          }
        }
        if (counted > capBytes) {
          const error = new ResponseCapError(capBytes);
          abort.abort(error);
          void source.cancel(error).catch(() => {});
          controller.error(error);
          onOverflow(error);
          return;
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        return source.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
