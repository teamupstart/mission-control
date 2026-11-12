import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  DAEMON_HEADERS_TIMEOUT_MS,
  DAEMON_KEEP_ALIVE_TIMEOUT_MS,
  holdIdleConnections,
} from "../src/server/http-keep-alive.ts";

test("the daemon holds idle connections past an ordinary pause, and advertises it", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  holdIdleConnections(server);
  // Node's own five seconds is the window a pooled http.Agent client raced under load.
  assert.ok(server.keepAliveTimeout >= 60_000);
  assert.equal(server.keepAliveTimeout, DAEMON_KEEP_ALIVE_TIMEOUT_MS);
  // Shorter headers timeout would cut an idle keep-alive connection as a stalled request.
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
  assert.equal(server.headersTimeout, DAEMON_HEADERS_TIMEOUT_MS);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new http.Agent({ keepAlive: true });
  try {
    const { port } = server.address() as AddressInfo;
    const header = await new Promise<string | undefined>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, agent }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["keep-alive"] as string | undefined));
      }).on("error", reject);
    });
    // `fetch` reads this hint and closes its idle socket before the daemon does.
    assert.equal(header, `timeout=${DAEMON_KEEP_ALIVE_TIMEOUT_MS / 1000}`);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
