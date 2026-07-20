import { test } from "node:test";
import assert from "node:assert/strict";

import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { resolveBin, TMUX_BIN } from "../src/server/terminal/bin.ts";
import { tmuxMultiplexer, toMuxClient, toMuxPane } from "../src/server/terminal/tmux.ts";
import { toEmulatorPane, weztermEmulator } from "../src/server/terminal/wezterm.ts";
import { ALL_KEYS } from "../src/server/terminal/types.ts";

// What is at stake: the three things the two backends disagree about, which are resolved at
// ~20 call sites today and must be resolved once, here.
//
//   - keys. tmux takes NAMES ("BTab", "Up"); wezterm takes escape SEQUENCES ("\x1b[Z",
//     "\x1b[A"). A caller that knows either convention has a vendor written into it, and a
//     third backend will use a third convention.
//   - pane ids. wezterm's are numbers, tmux's are strings ("%3").
//   - cwd. wezterm reports a `file://` URL, tmux a plain path.
//
// Asserted against a fake exec, deliberately: the interesting property of an adapter is the
// argv it emits, and a test that shells out to a real tmux asserts that on the machines
// that happen to have one and silently asserts nothing everywhere else. The keystroke path
// is exactly where that matters - a swallowed or mistranslated key is invisible.

interface Call {
  bin: string;
  args: string[];
}

function recorder(results: RunResult[] = []) {
  const calls: Call[] = [];
  let n = 0;
  const exec = async (bin: string, args: string[]): Promise<RunResult> => {
    calls.push({ bin, args });
    return results[n++] ?? stubRun({ stdout: "", stderr: "", code: 0 });
  };
  return { calls, exec };
}

const MUX = { session: "api", windowIndex: 0, paneId: "%3" };
const EMU = { paneId: "5", tabId: "2" };

test("every key renders into each backend's own convention", async () => {
  for (const key of ALL_KEYS) {
    const tmux = recorder();
    await tmuxMultiplexer(tmux.exec).write.keys(MUX, [key]);
    const tmuxRendered = tmux.calls[0]!.args.at(-1)!;

    const wez = recorder();
    await weztermEmulator(wez.exec).write!.keys(EMU, [key]);
    const wezRendered = wez.calls[0]!.args.at(-1)!;

    // Neither backend may pass the vocabulary word through. tmux would type "shift-tab" as
    // literal text; wezterm would write those nine bytes into the pty.
    assert.notEqual(tmuxRendered, key, `tmux must translate ${key}`);
    assert.notEqual(wezRendered, key, `wezterm must translate ${key}`);
    assert.notEqual(tmuxRendered, wezRendered, `${key} must differ between the two`);
  }
});

test("tmux sends key names, and text literally", async () => {
  const { calls, exec } = recorder();
  const tmux = tmuxMultiplexer(exec);

  await tmux.write.keys(MUX, ["shift-tab"]);
  assert.deepEqual(calls[0]!.args, ["send-keys", "-t", "%3", "--", "BTab"]);

  // `-l` is the difference between typing a body and pressing whatever it happens to spell.
  await tmux.write.text(MUX, "Enter");
  assert.deepEqual(calls[1]!.args, ["send-keys", "-t", "%3", "-l", "--", "Enter"]);
});

test("a body beginning with a dash is typed, not parsed as flags", async () => {
  // Both CLIs parse their trailing arguments as options, so "-v is what broke it" - an
  // ordinary reply - dies in the arg parser and never reaches the pane. Verified against
  // tmux 3.6b (`unknown flag -v`, exit 1) and wezterm's clap parser (`unexpected argument
  // '-v'`), both fixed by the terminator, and neither visible to the caller as anything but
  // a failed write.
  const body = "-v is what broke it";

  const tmux = recorder();
  await tmuxMultiplexer(tmux.exec).write.text(MUX, body);
  assert.deepEqual(tmux.calls[0]!.args, ["send-keys", "-t", "%3", "-l", "--", body]);

  const wez = recorder();
  await weztermEmulator(wez.exec).write!.paste!(EMU, body);
  assert.deepEqual(wez.calls[0]!.args.slice(-2), ["--", body]);

  // The agent binary is a trailing argument of `new-session` for the same reason.
  const spawn = recorder();
  await tmuxMultiplexer(spawn.exec).sessions!.spawnDetached({
    name: "api",
    cwd: "/w/api",
    argv: ["claude", "--model", "opus"],
    sidePane: false,
  });
  assert.deepEqual(spawn.calls[0]!.args.slice(-4), ["--", "claude", "--model", "opus"]);
});

test("wezterm sends escape sequences, and distinguishes typing from pasting", async () => {
  const { calls, exec } = recorder();
  const wez = weztermEmulator(exec);

  await wez.write!.keys(EMU, ["shift-tab"]);
  assert.deepEqual(calls[0]!.args, [
    "cli",
    "--no-auto-start",
    "send-text",
    "--pane-id",
    "5",
    "--no-paste",
    "--",
    "\x1b[Z",
  ]);

  // Omitting --no-paste is what makes it a bracketed paste, which is the only way a
  // multi-line prompt reaches a composer without submitting at every newline.
  await wez.write!.paste!(EMU, "one\ntwo");
  assert.deepEqual(calls[1]!.args, [
    "cli",
    "--no-auto-start",
    "send-text",
    "--pane-id",
    "5",
    "--",
    "one\ntwo",
  ]);
});

test("a tmux paste stops at the buffer it could not set", async () => {
  // The buffer and the paste are two commands, and the caller's whole retry decision turns
  // on whether text reached the pane. A failed set-buffer must not be followed by a paste.
  const { calls, exec } = recorder([stubRun({ stdout: "", stderr: "no space", code: 1 })]);
  const res = await tmuxMultiplexer(exec).write.paste!(MUX, "body");

  assert.equal(res.ok, false);
  assert.equal(res.error, "no space");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args[0], "set-buffer");
});

test("a write that died rather than answering says so", async () => {
  // `outcomeUnknown` is the difference between "it was refused" and "we never found out",
  // and they call for opposite recoveries: a timed-out paste may well be in the composer,
  // so re-pasting on it appends a second copy of the prompt.
  const killed: RunResult = { stdout: "", stderr: "", code: 1, outcomeUnknown: true, overflowed: false };
  const { exec } = recorder([killed]);
  const res = await tmuxMultiplexer(exec).write.text(MUX, "hello");

  assert.equal(res.ok, false);
  assert.equal(res.outcomeUnknown, true);
  // Silent failure is the common case for an unresolvable target, so the fallback names it.
  assert.equal(res.error, "tmux send-keys failed");
});

test("a detached session gets its shell pane, and the session survives a failed split", async () => {
  const { calls, exec } = recorder([
    stubRun({ stdout: "", stderr: "", code: 0 }),
    stubRun({ stdout: "", stderr: "no room", code: 1 }),
  ]);
  const res = await tmuxMultiplexer(exec).sessions!.spawnDetached({
    name: "api",
    cwd: "/w/api",
    argv: ["claude", "--model", "opus"],
    sidePane: true,
  });

  // The split is a convenience; the session is what was asked for.
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0]!.args, [
    "new-session",
    "-d",
    "-s",
    "api",
    "-c",
    "/w/api",
    "--",
    "claude",
    "--model",
    "opus",
  ]);
  assert.equal(calls[1]!.args[0], "split-window");
});

test("the argv that attaches a terminal honours the resolved binary", () => {
  // This argv is handed to an emulator to spawn, so it is the one place a binary outside
  // PATH has to be spelled out rather than assumed - a bare "tmux" here would ignore the
  // spec the adapter already carries.
  assert.deepEqual(tmuxMultiplexer().sessions!.attachArgv("api"), [
    resolveBin(TMUX_BIN),
    "attach",
    "-t",
    "api",
  ]);
});

test("tmux rejects the names its own target grammar cannot express", () => {
  const names = tmuxMultiplexer().sessions!.validateName!;
  // Separators in `session:window.pane`.
  assert.ok(names("api.v2"));
  assert.ok(names("api:v2"));
  // The session-ID sigil: `-t '$0'` resolves by ID and never falls back to a name lookup,
  // so focus and kill would target whichever session holds ID 0.
  assert.ok(names("$0"));
  assert.equal(names("api-v2"), null);
});

test("pane ids and cwds are normalized at the boundary", () => {
  const emu = toEmulatorPane({
    paneId: 5,
    tabId: 2,
    windowId: 0,
    tabTitle: "api",
    windowTitle: "",
    cwd: "file://host/Users/me/w%20ork",
    tty: "ttys012",
    isActive: true,
  });
  // Numbers become strings, so a caller can hold a pane id without knowing whose it is.
  assert.equal(emu.paneId, "5");
  assert.equal(emu.tabId, "2");
  // A URL is not a path, and only one call site converts it today.
  assert.equal(emu.cwd, "/Users/me/w ork");

  const mux = toMuxPane({
    session: "api",
    windowIndex: 1,
    windowName: "agent",
    paneId: "%3",
    panePid: 42,
    tty: "ttys028",
    currentCommand: "claude",
    currentPath: "/w/api",
  });
  assert.equal(mux.paneId, "%3");
  assert.equal(mux.cwd, "/w/api");
});

test("client ttys are normalized so the host-tab join is an equality test", () => {
  // tmux reports `/dev/ttys028` and wezterm reports `ttys012`. The strip happens inline at
  // the one join today, which is a normalization bug waiting for a backend that reports the
  // prefix on both sides.
  assert.equal(toMuxClient({ tty: "/dev/ttys028", session: "api" }).tty, "ttys028");
  assert.equal(toMuxClient({ tty: "", session: "api" }).tty, null);
});

test("a binary is the env override, then the first path that exists, then PATH", () => {
  const spec = { env: "MISSION_TEST_BIN", candidates: ["/definitely/not/here", "widget"] };
  // The bare name is never probed on disk - it is resolved by the OS at spawn time, which
  // is what makes it the fallback rather than a match.
  assert.equal(resolveBin(spec), "widget");

  process.env.MISSION_TEST_BIN = "/opt/widget";
  try {
    assert.equal(resolveBin(spec), "/opt/widget");
  } finally {
    delete process.env.MISSION_TEST_BIN;
  }
});
