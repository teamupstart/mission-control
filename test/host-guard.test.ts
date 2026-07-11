import { test } from "node:test";
import assert from "node:assert/strict";
import { hostIsLoopback } from "../src/server/routes.ts";

test("hostIsLoopback accepts loopback hosts and rejects everything else", () => {
  // Same-origin UI (prod) and Vite-proxied dev both send a loopback Host.
  assert.equal(hostIsLoopback("127.0.0.1:7317"), true);
  assert.equal(hostIsLoopback("localhost:5173"), true);
  assert.equal(hostIsLoopback("127.0.0.1"), true);
  assert.equal(hostIsLoopback("[::1]:7317"), true);
  assert.equal(hostIsLoopback("LOCALHOST:7317"), true);

  // A DNS-rebinding attacker's page sends its own domain as Host - reject it.
  assert.equal(hostIsLoopback("evil.com:7317"), false);
  assert.equal(hostIsLoopback("attacker.127.0.0.1.nip.io:7317"), false);
  assert.equal(hostIsLoopback("10.0.0.5:7317"), false);
  assert.equal(hostIsLoopback(undefined), false);
  assert.equal(hostIsLoopback(""), false);
});
