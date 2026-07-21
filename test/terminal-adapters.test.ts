import { test } from "node:test";
import assert from "node:assert/strict";

import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { binEnv, resolveBin, TMUX_BIN, WEZTERM_BIN } from "../src/server/terminal/bin.ts";
import { parseClients, parsePanes, tmuxMultiplexer } from "../src/server/terminal/tmux.ts";
import { parsePanes as parseEmulatorPanes, weztermEmulator } from "../src/server/terminal/wezterm.ts";
import { ALL_KEYS } from "../src/server/terminal/types.ts";

// What is at stake: the things the two backends disagree about, which used to be resolved at
// ~20 call sites and must be resolved once, here.
//
//   - keys. tmux takes NAMES ("BTab", "Up"); wezterm takes escape SEQUENCES ("\x1b[Z",
//     "\x1b[A"). A caller that knows either convention has a vendor written into it, and a
//     third backend will use a third convention.
//   - pane ids. wezterm's are numbers, tmux's are strings ("%3").
//   - cwd. wezterm reports a `file://` URL, tmux a plain path.
//   - the environment. Each backend has one inherited variable that pins its CLI to a single
//     server instance, and an adapter that enumerates on one socket and writes on another is
//     the failure this layer exists to make impossible.
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
  // The other direction, and the agreement between them, is `terminal-name-rules.test.ts`.
  const names = tmuxMultiplexer().sessions!.names.validate;
  // Separators in `session:window.pane`.
  assert.ok(names("api.v2"));
  assert.ok(names("api:v2"));
  // The session-ID sigil: `-t '$0'` resolves by ID and never falls back to a name lookup,
  // so focus and kill would target whichever session holds ID 0.
  assert.ok(names("$0"));
  assert.equal(names("api-v2"), null);
});

test("each backend enumerates through its own adapter, and normalizes at that boundary", async () => {
  // Enumeration moved off `discovery/*` and onto the adapters, so this is where the format
  // strings and the JSON shape are now pinned - against verbatim backend output, which is
  // the only way it asserts anything on a machine with neither installed.
  const tmuxOut = ["api\x1f1\x1fagent\x1f%3\x1f42\x1f/dev/ttys028\x1f/w/api", ""].join("\n");
  const tmux = recorder([stubRun({ stdout: tmuxOut, stderr: "", code: 0 })]);
  const [muxPane] = await tmuxMultiplexer(tmux.exec).list();
  assert.deepEqual(tmux.calls[0]!.args.slice(0, 3), ["list-panes", "-a", "-F"]);
  assert.equal(muxPane?.paneId, "%3");
  assert.equal(muxPane?.windowIndex, 1);
  // tmux reports `/dev/ttys028` and wezterm reports `ttys012`; both arrive normalized so the
  // host-tab join is an equality test rather than a strip at the one call site that does it.
  assert.equal(muxPane?.tty, "ttys028");
  assert.equal(muxPane?.cwd, "/w/api");

  const wezOut = JSON.stringify([
    {
      pane_id: 5,
      tab_id: 2,
      window_id: 0,
      tab_title: "api",
      cwd: "file://host/Users/me/w%20ork",
      tty_name: "ttys012",
      is_active: true,
    },
  ]);
  const wez = recorder([stubRun({ stdout: wezOut, stderr: "", code: 0 })]);
  const [emuPane] = await weztermEmulator(wez.exec).list!();
  assert.deepEqual(wez.calls[0]!.args, ["cli", "--no-auto-start", "list", "--format", "json"]);
  // Numbers become strings, so a caller can hold a pane id without knowing whose it is.
  assert.equal(emuPane?.paneId, "5");
  assert.equal(emuPane?.tabId, "2");
  // A URL is not a path.
  assert.equal(emuPane?.cwd, "/Users/me/w ork");
});

test("an absent or unparseable backend enumerates as empty, never as a throw", async () => {
  // The silent-degradation contract discovery is built on: the product works fine on a
  // machine with neither backend installed, and a sweep that threw would take every card on
  // the machine down with it.
  const dead = stubRun({ stdout: "", stderr: "no server running", code: 1 });
  assert.deepEqual(await tmuxMultiplexer(recorder([dead]).exec).list(), []);
  assert.deepEqual(await tmuxMultiplexer(recorder([dead]).exec).clients!(), []);
  assert.deepEqual(await weztermEmulator(recorder([dead]).exec).list!(), []);

  // Short lines and non-JSON are the same answer: a half-parsed pane is no more use than none.
  assert.deepEqual(parsePanes("\n  \napi\x1f1\n"), []);
  assert.deepEqual(parseClients("nosep\n"), []);
  assert.deepEqual(parseEmulatorPanes("<html>not json</html>"), []);
  assert.deepEqual(parseEmulatorPanes('{"panes":[]}'), [], "an object is not the array we asked for");
});

test("a client with no tty is dropped rather than joined against every pane that has none", () => {
  assert.deepEqual(parseClients("/dev/ttys028\x1fapi"), [{ tty: "ttys028", session: "api" }]);
  assert.deepEqual(parseClients("\x1fapi"), []);
});

test("a backend drops its own environment pin, and only its own", async () => {
  const base = {
    PATH: "/usr/bin",
    TMUX: "/private/tmp/tmux-501/work,123,0",
    WEZTERM_UNIX_SOCKET: "/Users/x/.local/share/wezterm/gui-sock-79736",
  };

  // wezterm's pin goes STALE - `gui-sock-<pid>` dies with the GUI that minted it, and the
  // inherited value then resolves to nothing, so every tab falls back to a `claude <pid>`
  // name that Focus cannot raise. Dropping it recovers the live default.
  const wezEnv = binEnv(WEZTERM_BIN, base);
  assert.equal(wezEnv.WEZTERM_UNIX_SOCKET, undefined);
  assert.equal(wezEnv.PATH, "/usr/bin", "everything else passes through untouched");
  // Not the other backend's. A shared scrub list would be one vendor's rule applied to
  // every backend on the machine.
  assert.equal(wezEnv.TMUX, base.TMUX);

  // tmux declares NOTHING to drop, and that is a decision rather than an omission - see
  // `TMUX_BIN`. `TMUX` names a server that is alive by construction, so dropping it picks a
  // different live server rather than restoring a dead one; and the ~19 inline
  // `run("tmux", …)` writes still inherit it, so scrubbing it here alone would build cards
  // from one server's pane ids and send keystrokes to another server's pane of that name.
  assert.deepEqual(binEnv(TMUX_BIN, base), base);
});

test("the env rule reaches every command, not just the spec", async () => {
  // Enumeration and writes have to hit the SAME server, or a pane id from one is addressed
  // against another - so a per-command `env` that any one method forgets is the whole bug.
  const seen: (NodeJS.ProcessEnv | undefined)[] = [];
  const exec = async (_b: string, _a: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.push(opts?.env);
    return stubRun({ stdout: "", stderr: "", code: 0 });
  };
  const wez = weztermEmulator(exec);
  await wez.list!();
  await wez.write!.text(EMU, "hello");
  await wez.capture!(EMU);
  assert.equal(seen.length, 3);
  for (const env of seen) {
    assert.ok(env, "every wezterm command carries an explicit environment");
    assert.equal(env.WEZTERM_UNIX_SOCKET, undefined);
  }
});

test("a binary is the env override, then the first path that exists, then PATH", () => {
  const spec = { env: "MISSION_TEST_BIN", candidates: ["/definitely/not/here", "widget"], dropEnv: [] };
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
