import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { weztermEmulator } from "../src/server/terminal/wezterm.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";
import { stubRun } from "../src/server/util/exec.ts";

// Real Unix sockets, with only WezTerm's CLI protocol faked. In particular a restart
// unlinks and rebinds the SAME pathname between discovery, validation and delivery.
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "mc-wez-incarnation-"));
  const socket = join(dir, "sock");
  let server: Server;
  let received: string[] = [];
  let diagnostic = true;
  let beforeSend: (() => Promise<void>) | undefined;
  async function start() {
    received = [];
    server = createServer((client) => {
      client.once("data", (data) => {
        const request = JSON.parse(data.toString());
        if (request.args.includes("send-text")) received.push(request.input);
        client.end(JSON.stringify(stubRun({ code: 0, stderr: "", stdout: request.args.includes("list")
          ? JSON.stringify([{ pane_id: 1, tab_id: 1, window_id: 1, tty_name: "/dev/tty1" }]) : "" })));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
  }
  async function restart() {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await start();
  }
  await start();
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const exec: TerminalExec = async (_bin, args, opts) => {
    assert.ok(args.includes("--no-auto-start"));
    assert.equal(opts?.env?.WEZTERM_UNIX_SOCKET, undefined, "never inherit a stale socket");
    const selected = args.find((arg) => arg.startsWith("WEZTERM_UNIX_SOCKET="))?.slice("WEZTERM_UNIX_SOCKET=".length) ?? socket;
    if (args.includes("send-text") && beforeSend) {
      const action = beforeSend; beforeSend = undefined; await action();
    }
    return await new Promise((resolve) => {
      const client = createConnection(selected);
      let output = "";
      client.once("connect", () => client.write(JSON.stringify({ args, input: opts?.input })));
      client.on("data", (data) => { output += data; });
      client.once("error", () => resolve(stubRun({ code: 1, stdout: "", stderr: "socket unavailable" })));
      client.once("end", () => {
        const result = JSON.parse(output);
        result.stderr = diagnostic ? `TRACE wezterm_client::client > connect to Socket(${JSON.stringify(selected)})\n` : "unrecognized endpoint";
        resolve(result);
      });
    });
  };
  return { adapter: weztermEmulator(exec), restart, received: () => received,
    race: (action: () => Promise<void>) => { beforeSend = action; },
    hideEndpoint: () => { diagnostic = false; } };
}

test("WezTerm refuses a stale pane after native socket replacement and accepts fresh discovery", async (t) => {
  const f = await fixture(t);
  const old = (await f.adapter.list!())![0]!;
  assert.equal((await f.adapter.write!.text(old, "current")).ok, true);
  assert.deepEqual(f.received(), ["current"]);
  await f.restart();
  assert.equal((await f.adapter.write!.text(old, "stale")).ok, false);
  assert.deepEqual(f.received(), [], "replacement must receive no stale bytes");
  const current = (await f.adapter.list!())![0]!;
  assert.equal(current.paneId, old.paneId, "numeric IDs are reused");
  assert.equal((await f.adapter.write!.text(current, "fresh")).ok, true);
  assert.deepEqual(f.received(), ["fresh"]);
});

test("WezTerm cannot redirect a write when the socket is replaced at the final exec boundary", async (t) => {
  const f = await fixture(t);
  const old = (await f.adapter.list!())![0]!;
  f.race(f.restart);
  assert.equal((await f.adapter.write!.text(old, "racing")).ok, false);
  assert.deepEqual(f.received(), []);
});

test("WezTerm refuses legacy handles without incarnation evidence", async (t) => {
  const f = await fixture(t);
  const legacy = { paneId: "1", tabId: "1" };
  assert.equal((await f.adapter.write!.text(legacy, "unknown")).ok, false);
  assert.equal((await f.adapter.write!.keys(legacy, ["enter"])).ok, false);
  assert.equal((await f.adapter.write!.paste!(legacy, "unknown")).ok, false);
  assert.deepEqual(f.received(), []);
});

test("WezTerm keeps unknown endpoint observations unavailable and refuses all stale input forms", async (t) => {
  const f = await fixture(t);
  const old = (await f.adapter.list!())![0]!;
  await f.restart();
  assert.equal((await f.adapter.write!.keys(old, ["enter"])).ok, false);
  assert.equal((await f.adapter.write!.paste!(old, "stale paste")).ok, false);
  assert.equal(await f.adapter.capture!(old), null);
  assert.equal((await f.adapter.retitle!(old, "stale title")).ok, false);
  if (f.adapter.focus?.granularity === "pane") assert.equal((await f.adapter.focus.raise(old)).ok, false);
  assert.deepEqual(f.received(), []);
  const current = (await f.adapter.list!())![0]!;
  f.hideEndpoint();
  assert.equal(await f.adapter.list!(), null, "unidentified endpoint is not empty inventory");
  assert.equal((await f.adapter.write!.text(current, "unknown endpoint")).ok, false);
  assert.deepEqual(f.received(), []);
});
