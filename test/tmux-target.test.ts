import assert from "node:assert/strict";
import test from "node:test";
import { parseClients, parsePanes, SEP, tmuxMultiplexer } from "../src/server/terminal/tmux.ts";
import { tmuxAddress, TMUX_ADDRESS_FORMAT } from "../src/server/terminal/tmux-target.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

test("discovery and client enumeration share an opaque address without displaying it", () => {
  const address = ["/tmp/mission-test.sock", "123", "456", "$7"];
  const [pane] = parsePanes(["Human name", "0", "Editor", "%5", "321", "/dev/ttys1", "/repo", ...address].join(SEP));
  const [client] = parseClients(["/dev/ttys2", "Human name", ...address].join(SEP));
  assert.ok(pane);
  assert.ok(client);
  assert.equal(pane.session, client.session);
  assert.equal(pane.sessionName, "Human name");
  const attach = tmuxMultiplexer().sessions!.attachArgv!(pane.session);
  assert.deepEqual(attach.slice(1), ["-S", "/tmp/mission-test.sock", "attach", "-t", "$7"]);
});

test("unknown or malformed destructive targets never reach tmux", async () => {
  const mux = tmuxMultiplexer(async () => {
    assert.fail("an unverified target must not execute a command");
  });
  const malformed = ["work", "=work", "$0", "tmux:{}", "tmux:not-json",
    'tmux:{"socket":"/tmp/test","pid":"1;kill-server","started":"1","id":"$0"}'];
  for (const session of malformed) {
    assert.equal(await mux.sessions!.alive!(session), null);
    assert.equal((await mux.sessions!.kill!(session)).ok, false);
    assert.equal((await mux.sessions!.closeIfOnlyPane!({ session, paneId: "%0", windowIndex: 0 })).ok, false);
  }
  const session = tmuxAddress(["/tmp/test", "1", "1", "$0"])!;
  assert.equal((await mux.sessions!.closeIfOnlyPane!({ session, paneId: "bad-pane", windowIndex: 0 })).ok, false);
});

test("captured tmux liveness distinguishes exact absence from an unreadable server", async () => {
  const socket = "/tmp/mission-captured.sock";
  const fields = [socket, "123", "456", "$7"];
  const session = tmuxAddress(fields)!;
  const probeResult = (partial: Partial<RunResult> = {}): RunResult => ({
    ...stubRun({ stdout: "", stderr: "", code: 0 }), ...partial,
  });
  const cases = [
    { label: "same identity", result: probeResult({ stdout: fields.join(SEP) }), alive: true },
    { label: "different session", result: probeResult({ stdout: [socket, "123", "456", "$8"].join(SEP) }), alive: false },
    { label: "replacement server", result: probeResult({ stdout: [socket, "999", "789", "$7"].join(SEP) }), alive: false },
    { label: "server exited", result: probeResult({ code: 1, stderr: `no server running on ${socket}` }), alive: false },
    { label: "socket removed", result: probeResult({ code: 1, stderr: `error connecting to ${socket} (No such file or directory)` }), alive: false },
    { label: "server kept alive without sessions", result: probeResult({ code: 1, stderr: "no sessions" }), alive: false },
    { label: "permission denied", result: probeResult({ code: 1, stderr: `error connecting to ${socket} (Permission denied)` }), alive: null },
    { label: "timeout", result: probeResult({ code: 1, outcomeUnknown: true, stderr: `no server running on ${socket}` }), alive: null },
    { label: "malformed identity", result: probeResult({ stdout: "unreadable" }), alive: null },
    { label: "empty successful listing", result: probeResult(), alive: false },
  ];
  for (const scenario of cases) {
    const mux = tmuxMultiplexer(async (_bin, args) => {
      assert.deepEqual(args, ["-S", socket, "list-sessions", "-F", TMUX_ADDRESS_FORMAT.join(SEP)]);
      return scenario.result;
    });
    assert.equal(await mux.sessions!.alive!(session), scenario.alive, scenario.label);
  }
});
