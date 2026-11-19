// F6/F1: the mctl registry and its flag gate. Commands themselves arrive in later packages.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { COMMANDS, findCommand } from "../src/cli/commands/index.ts";
import { DAEMON_DOWN_MESSAGE, FLAG_OFF_MESSAGE, main, readHeadlessFlag, type FlagState } from "../src/cli/index.ts";
import { startFakeDaemon } from "./helpers/home-dispatch-fakes.ts";

function capture() {
  let out = "", err = "";
  return {
    io: { stdout: { write: (t: string) => { out += t; } }, stderr: { write: (t: string) => { err += t; } }, env: {} },
    out: () => out, err: () => err,
  };
}
const flag = (state: FlagState) => async () => state;

test("F6 registry: every command in the spec is registered, once, with a stub owner", () => {
  assert.deepEqual(COMMANDS.map((c) => c.name).sort(), [
    "claude", "config", "daemon", "describe", "doctor", "get", "logs", "pick", "run", "setup", "status",
  ]);
  assert.equal(findCommand("ls")?.name, "get");
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length);
  assert.deepEqual(COMMANDS.filter((c) => !c.needsFlag).map((c) => c.name).sort(), ["doctor", "setup"]);
});

test("F1 mctl flag off: every command except setup and doctor exits 2 with the run-setup message", async () => {
  for (const spec of COMMANDS.filter((c) => c.needsFlag)) {
    const c = capture();
    assert.equal(await main([spec.name], { io: c.io, readFlag: flag("off") }), 2, spec.name);
    assert.equal(c.err(), FLAG_OFF_MESSAGE + "\n");
    assert.equal(c.out(), "");
  }
});

test("F1 mctl flag off: setup and doctor still run (they are how the flag is turned on)", async () => {
  for (const name of ["setup", "doctor"]) {
    const c = capture();
    const code = await main([name], { io: c.io, readFlag: flag("off") });
    assert.equal(code, 1, "the WP1 stub fails, but not with the flag-off exit");
    assert.match(c.err(), /not implemented yet/);
  }
});

test("F1 mctl flag on: a gated command reaches its stub", async () => {
  const c = capture();
  assert.equal(await main(["get", "tasks"], { io: c.io, readFlag: flag("on") }), 1);
  assert.match(c.err(), /mctl get is not implemented yet \(WP6a\)/);
});

test("F1 mctl daemon down: exits 1 with the start-the-app message", async () => {
  const c = capture();
  assert.equal(await main(["status"], { io: c.io, readFlag: flag("unreachable") }), 1);
  assert.equal(c.err(), DAEMON_DOWN_MESSAGE + "\n");
});

test("F6 mctl usage: no command exits 2, help exits 0, an unknown command exits 2 and lists commands", async () => {
  const none = capture();
  assert.equal(await main([], { io: none.io }), 2);
  assert.match(none.out(), /usage: mctl/);
  const help = capture();
  assert.equal(await main(["--help"], { io: help.io }), 0);
  const unknown = capture();
  assert.equal(await main(["nope"], { io: unknown.io }), 2);
  assert.match(unknown.err(), /unknown command nope/);
});

test("F1 mctl reads the flag from the daemon on every call: off, on, off", async () => {
  const daemon = await startFakeDaemon({ flag: false });
  const prior = process.env.MISSION_PORT;
  try {
    // BASE_URL is fixed at import, so drive the fake through an injected fetch bound to its port.
    const viaFake: typeof fetch = (url, init) => fetch(String(url).replace(/:\d+/, `:${daemon.port}`), init);
    assert.equal(await readHeadlessFlag(viaFake), "off");
    daemon.setFlag(true);
    assert.equal(await readHeadlessFlag(viaFake), "on");
    daemon.setFlag(false);
    assert.equal(await readHeadlessFlag(viaFake), "off");
    assert.ok(daemon.requests.every((r) => r.path === "/api/feature-flags" && r.headers["x-mission-operation-surface"] === "cli"));
    daemon.route("GET /api/feature-flags", 500, { error: "boom" });
    assert.equal(await readHeadlessFlag(viaFake), "unreachable");
  } finally {
    if (prior !== undefined) process.env.MISSION_PORT = prior;
    await daemon.close();
  }
});

test("F6 mctl entrypoint: running the source file prints usage and exits 0 for --help", () => {
  const entry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const res = spawnSync(process.execPath, ["--import", "tsx", entry, "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /usage: mctl/);
});
