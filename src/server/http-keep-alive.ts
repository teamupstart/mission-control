import type { Server } from "node:http";

// How long the daemon holds an idle keep-alive connection open.
//
// Node closes one after five seconds, which is shorter than the pauses between requests from
// almost every client this daemon has: a dashboard tab, an agent's MCP client, a hook, a test
// driving the API between browser steps. Node's own `http.Agent`, and clients built on it,
// keep an idle socket with no timeout of their own, so the next request after a pause near five
// seconds is written to a socket the daemon is closing at that moment, and the client reads
// ECONNRESET. On an idle machine the window is a few milliseconds. On a loaded one the
// client's event loop is late to see the close: a Playwright `request.put` to
// `/api/ui/config` failed that way in an e2e run on a loaded Windows machine.
//
// Holding idle connections for a minute moves that boundary past any ordinary pause. Clients
// that read the advertised `Keep-Alive: timeout` hint, as Node's `fetch` does, close first
// either way; under load `fetch` was not seen to race the five-second window at all.
// `headersTimeout` must stay longer than the keep-alive window, or Node would cut an idle
// connection as a request that never finished its headers.

export const DAEMON_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const DAEMON_HEADERS_TIMEOUT_MS = DAEMON_KEEP_ALIVE_TIMEOUT_MS + 1_000;

export function holdIdleConnections(server: Pick<Server, "keepAliveTimeout" | "headersTimeout">): void {
  server.keepAliveTimeout = DAEMON_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = DAEMON_HEADERS_TIMEOUT_MS;
}
