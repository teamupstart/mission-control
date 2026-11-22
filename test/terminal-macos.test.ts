import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_OS_EXECUTABLES } from "../src/server/executables/catalog.ts";
import { macosTerminalEmulator } from "../src/server/terminal/macos-terminal.ts";
import { defaultTerminalTargetDeps, launchTerminal, terminalTargetViews } from "../src/server/terminal/targets.ts";
import { shellCommand } from "../src/server/terminal/shell.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

const spec = { name: "agent", cwd: "/tmp/Anne's worktree", argv: ["/bin/echo", "first\nsecond"] };

test("preview exposes the macOS adapter and explicit launch uses its new window", async () => {
  const scripts: string[] = [];
  let enabled = false;
  const emulator = macosTerminalEmulator(async (bin, args, opts) => {
    assert.equal(bin, FIXED_OS_EXECUTABLES.osascript);
    assert.deepEqual(args, []);
    scripts.push(opts!.input!);
    return stubRun({ code: 0, stdout: "/dev/ttys001\n", stderr: "" });
  }, () => enabled);
  const deps = {
    ...defaultTerminalTargetDeps,
    multiplexers: {},
    emulators: { [emulator.id]: emulator },
    installed: () => true,
    unsupported: (bin: typeof emulator.bin) => bin.unsupportedReason?.("darwin") ?? null,
  };
  assert.deepEqual(terminalTargetViews(deps), []);
  assert.equal((await launchTerminal(emulator.id, spec, deps)).status, 404);
  assert.equal(scripts.length, 0);
  enabled = true;
  assert.equal(terminalTargetViews(deps)[0]?.unavailable, null);
  assert.match(emulator.bin.unsupportedReason!("linux")!, /macOS only/);
  assert.deepEqual(await launchTerminal(emulator.id, spec, deps), {
    label: "macOS Terminal",
    ok: true,
    status: 200,
    homeName: null,
    terminalResourceId: "emulator:macos-terminal:ttys001",
  });
  assert.match(scripts[0]!, /set newTab to do script \(/);
  assert.match(scripts[0]!, /\(character id 10\)/);
  const command = shellCommand(["/bin/sh", "-c", `cd -- ${shellCommand([spec.cwd])} && exec ${shellCommand(spec.argv)}`]);
  assert.ok(scripts[0]!.includes(command.split("\n")[0]!.replaceAll('"', '\\"')));
  assert.match(scripts[0]!, /return tty of newTab/);
});

test("matches tabs by TTY and refuses untrustworthy inventories", async () => {
  let stdout = "17\t/dev/ttys001\t1\n17\t/dev/ttys002\t0\n";
  let overflowed = false;
  const scripts: string[] = [];
  const emulator = macosTerminalEmulator(async (_bin, _args, opts) => {
    scripts.push(opts!.input!);
    return { code: 0, stdout, stderr: "", outcomeUnknown: false, overflowed };
  }, () => true);
  const panes = await emulator.list!();
  assert.deepEqual(panes?.map(({ tty, paneId, windowId, isActive }) => ({ tty, paneId, windowId, isActive })), [
    { tty: "ttys001", paneId: "ttys001", windowId: "17", isActive: true },
    { tty: "ttys002", paneId: "ttys002", windowId: "17", isActive: false },
  ]);
  assert.match(scripts[0]!, /application id "com\.apple\.Terminal" is running/);
  const focus = emulator.focus!;
  assert.equal(focus.granularity, "pane");
  assert.equal((await focus.raise(panes![1]!)).ok, true);
  assert.match(scripts[1]!, /if tty of terminalTab is "\/dev\/ttys002" then/);
  assert.match(scripts[1]!, /set selected of terminalTab to true/);
  assert.equal((await focus.raise({ paneId: "invalid", tabId: "" })).ok, false);
  assert.equal(scripts.length, 2);
  assert.equal(emulator.write, null);
  assert.equal(emulator.capture, null);
  assert.equal(emulator.retitle, null);

  overflowed = true;
  assert.equal(await emulator.list!(), null);
  overflowed = false;
  stdout = "17\t/dev/ttys001\t1\n18\t/dev/ttys001\t1\n";
  assert.equal(await emulator.list!(), null);
  stdout = "\n";
  assert.deepEqual(await emulator.list!(), []);
});

test("distinguishes denied, unconfirmed and untargetable launches", async () => {
  let result: RunResult = {
    ...stubRun({ code: 1, stdout: "", stderr: "private launch arguments (-1743)" }),
  };
  const emulator = macosTerminalEmulator(async () => result, () => true);
  const launch = () => emulator.spawn!.tab({ ...spec, title: spec.name });
  const denied = await launch();
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /Privacy & Security/);
  assert.doesNotMatch(denied.error!, /private/);
  result = { ...result, stderr: "timed out", outcomeUnknown: true };
  assert.equal((await launch()).outcomeUnknown, true);
  result = { ...result, code: 0, stderr: "", outcomeUnknown: false };
  assert.deepEqual(await launch(), { ok: true, outcomeUnknown: false, target: null });
});
