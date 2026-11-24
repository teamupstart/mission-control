import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import test from "node:test";
import { generate } from "selfsigned";
import { desktopVoiceEndpointPath, HOST } from "../src/shared/harness-runtime.mjs";
import { ensureToken } from "../src/server/auth.ts";
import { serveDesktopVoice } from "../src/server/voice/desktop-endpoint.ts";
import { desktopVoiceConnection } from "../src/main/voice-connection.ts";

test("status-only voice POSTs release unfinished response bodies on success and refusal", { timeout: 10000 }, async t => {
  ensureToken();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const responses = new EventEmitter();
  const server = await serveDesktopVoice((req, res) => {
    res.once("close", () => responses.emit("closed", req.url));
    res.writeHead(req.url === "/voice/shell-report" ? 200 : 503);
    res.write("body held open");
  }, desktopVoiceEndpointPath(), controller.signal);
  assert.ok(server);
  const connection = desktopVoiceConnection();
  assert.ok(connection);
  t.after(() => connection.close());
  for (const [path, status] of [["/voice/shell-report", 200], ["/api/voice/mute", 503]] as const) {
    const closed = once(responses, "closed", { signal: t.signal });
    const result = await connection.postStatus(path, {}, t.signal);
    assert.deepEqual(result, { ok: status === 200, status });
    assert.deepEqual(await closed, [path]);
  }
});

test("voice requests stay bound to the authenticated instance when its port is reused", async t => {
  ensureToken();
  const file = desktopVoiceEndpointPath();
  const first = new AbortController();
  t.after(() => first.abort());
  const server = await serveDesktopVoice((_req, res) => res.end("first instance"), file, first.signal);
  assert.ok(server);
  const { port } = JSON.parse(readFileSync(file, "utf8"));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const connection = desktopVoiceConnection();
  assert.ok(connection);
  t.after(() => connection.close());
  assert.equal(await (await connection.request("/events")).text(), "first instance");
  assert.equal((await connection.request("/api/health")).status, 404);
  const closed = once(server, "close");
  first.abort();
  await closed;
  assert.equal(existsSync(file), false);

  const other = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", algorithm: "sha256" });
  let requests = 0;
  const replacement = createServer({ key: other.private, cert: other.cert }, (_req, res) => {
    requests++;
    res.end();
  });
  replacement.listen(port, HOST);
  await once(replacement, "listening");
  t.after(() => { replacement.close(); replacement.closeAllConnections(); });
  for (const path of ["/voice/shell-report", "/api/voice/mute"]) {
    await assert.rejects(connection.request(path, { method: "POST" }), /fetch failed/);
  }
  assert.equal(requests, 0);
});
