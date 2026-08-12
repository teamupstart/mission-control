import { test } from "node:test";
import assert from "node:assert/strict";

import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { binEnv, resolveBin, TMUX_BIN, WEZTERM_BIN } from "../src/server/terminal/bin.ts";
import { parseClients, parsePanes, SEP, tmuxMultiplexer } from "../src/server/terminal/tmux.ts";
import { parsePanes as parseEmulatorPanes, weztermEmulator } from "../src/server/terminal/wezterm.ts";
import { shellCommand } from "../src/server/terminal/shell.ts";
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
  /**
   * What was piped to the child's stdin, and the reason this fake had to grow a third
   * field. A payload on argv and the same payload on stdin are the same call to a recorder
   * that only watches argv - which is precisely the difference between a prompt that
   * delivers and one that dies at `command too long`, so a test blind to it cannot guard
   * the bug this file's `write.text` / `write.paste` cases exist for.
   */
  input?: string;
}

function recorder(results: RunResult[] = []) {
  const calls: Call[] = [];
  let n = 0;
  const exec = async (
    bin: string,
    args: string[],
    opts?: { input?: string },
  ): Promise<RunResult> => {
    calls.push({ bin, args, input: opts?.input });
    return results[n++] ?? stubRun({ stdout: "", stderr: "", code: 0 });
  };
  return { calls, exec };
}

/** tmux's per-pane buffer name, spelled here so the argv assertions below read literally. */
const BUF = "harness-3";

const MUX = { session: "api", windowIndex: 0, paneId: "%3" };
const EMU = { paneId: "5", tabId: "2" };

test("every key renders into each backend's own convention", async () => {
  for (const key of ALL_KEYS) {
    const tmux = recorder();
    await tmuxMultiplexer(tmux.exec).write.keys(MUX, [key]);
    const tmuxRendered = tmux.calls[0]!.args.at(-1)!;

    const wez = recorder();
    await weztermEmulator(wez.exec).write!.keys(EMU, [key]);
    // Read off STDIN, not argv. wezterm's payload moved there when `send-text` stopped
    // taking a trailing argument, and `args.at(-1)` kept "passing" against `--no-paste` -
    // a flag that is equal to no key name and different from every tmux rendering, so all
    // three assertions below held while checking nothing about the key at all.
    const wezRendered = wez.calls[0]!.input!;

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

  // Keys stay on argv: they are a bounded vocabulary of short names, never a payload, and
  // routing them through a paste buffer would type the NAMES into the pane.
  await tmux.write.keys(MUX, ["shift-tab"]);
  assert.deepEqual(calls[0]!.args, ["send-keys", "-t", "%3", "--", "BTab"]);

  // Text goes through the buffer, so a body that happens to spell a key name is still typed
  // rather than pressed - the job `send-keys -l` used to do, now done by not being a key
  // command at all. `-r` keeps tmux from rewriting LF to CR, which is what makes this
  // `text` (a newline submits) rather than `paste`.
  await tmux.write.text(MUX, "Enter");
  assert.deepEqual(calls[1]!.args, ["load-buffer", "-b", BUF, "-"]);
  assert.equal(calls[1]!.input, "Enter");
  assert.deepEqual(calls[2]!.args, ["paste-buffer", "-r", "-d", "-b", BUF, "-t", "%3"]);

  // And the paste verb differs by exactly one flag: `-p` for bracketed paste, no `-r`.
  await tmux.write.paste!(MUX, "one\ntwo");
  assert.deepEqual(calls[3]!.args, ["load-buffer", "-b", BUF, "-"]);
  assert.equal(calls[3]!.input, "one\ntwo");
  assert.deepEqual(calls[4]!.args, ["paste-buffer", "-p", "-d", "-b", BUF, "-t", "%3"]);
});

test("a payload never rides on argv, however big it gets", async () => {
  // The regression guard for the bug this seam exists to close. tmux caps the total length
  // of a COMMAND far below the OS's argv limit - measured against 3.6b, 16,000 bytes as an
  // argument is accepted and 20,000 is refused with `command too long`, exit 1 - so a
  // dispatch carrying a phase document created its worktree, launched its agent, and then
  // died at prompt delivery with nothing in the composer.
  //
  // Asserting "the text is on stdin" is not enough on its own: what has to be true is that
  // it is NOT an argument, which is the property tmux's limit is levied against. So this
  // checks every argv entry of every call, and fails against both old spellings
  // (`set-buffer -b <buf> -- <text>` and `send-keys -l -- <text>`).
  const big = "x".repeat(64 * 1024);

  for (const verb of ["text", "paste"] as const) {
    const { calls, exec } = recorder();
    const tmux = tmuxMultiplexer(exec);
    const res = await (verb === "text" ? tmux.write.text(MUX, big) : tmux.write.paste!(MUX, big));

    assert.equal(res.ok, true, `${verb} should deliver`);
    assert.equal(calls[0]!.input, big, `${verb} must pipe the payload`);
    for (const call of calls) {
      for (const arg of call.args) {
        assert.ok(
          !arg.includes(big),
          `tmux ${verb} put a ${big.length}-byte payload in argv: ${call.args[0]}`,
        );
        // Nothing an adapter passes as an argument is a payload, so nothing it passes as an
        // argument has any business approaching tmux's limit.
        assert.ok(arg.length < 1024, `tmux ${verb} emitted a suspiciously long argv entry`);
      }
    }
  }

  // wezterm's ceiling is the OS's `ARG_MAX` rather than a tmux limit, but it is the same
  // defect and takes the same fix - its `send-text` reads the body from stdin when the
  // positional argument is omitted.
  for (const literal of [true, false]) {
    const { calls, exec } = recorder();
    const wez = weztermEmulator(exec);
    await (literal ? wez.write!.text(EMU, big) : wez.write!.paste!(EMU, big));

    assert.equal(calls[0]!.input, big);
    for (const arg of calls[0]!.args) assert.ok(!arg.includes(big), "wezterm put a payload in argv");
  }
});

test("an empty write succeeds without reaching for a buffer", async () => {
  // `load-buffer` with empty stdin exits 0 and creates NO buffer (measured, tmux 3.6b), so
  // the `paste-buffer` behind it would fail `no buffer harness-3` - turning what used to be
  // a no-op `send-keys -l -- ""` into a reported failure to reach the pane.
  const { calls, exec } = recorder();
  const res = await tmuxMultiplexer(exec).write.text(MUX, "");

  assert.equal(res.ok, true);
  assert.equal(calls.length, 0, "an empty write should spawn nothing at all");
});

test("a body beginning with a dash is typed, not parsed as flags", async () => {
  // Both CLIs parse their trailing arguments as options, so "-v is what broke it" - an
  // ordinary reply - dies in the arg parser and never reaches the pane. Verified against
  // tmux 3.6b (`unknown flag -v`, exit 1) and wezterm's clap parser (`unexpected argument
  // '-v'`), neither visible to the caller as anything but a failed write.
  //
  // A `--` terminator used to be what saved both. For the two WRITE paths it no longer
  // exists, and the hazard is gone in the stronger way: the body is not an argument any
  // more, so there is no parser to reach. That is the same move that removed the size
  // limit - a payload nobody passes as an argument is neither parsed nor counted - and this
  // case now pins that the body stays out of argv rather than that a terminator precedes it.
  const body = "-v is what broke it";

  const tmux = recorder();
  await tmuxMultiplexer(tmux.exec).write.text(MUX, body);
  assert.equal(tmux.calls[0]!.input, body);
  for (const call of tmux.calls) {
    assert.ok(!call.args.includes(body), "the body must not be a tmux argument");
  }

  const wez = recorder();
  await weztermEmulator(wez.exec).write!.paste!(EMU, body);
  assert.equal(wez.calls[0]!.input, body);
  assert.ok(!wez.calls[0]!.args.includes(body), "the body must not be a wezterm argument");

  // The terminator is still load-bearing everywhere a value genuinely IS an argument. The
  // shell-encoded agent command is one trailing argument of `new-session`, and a session
  // name is what `rename-session` takes.
  const spawn = recorder();
  const mux = tmuxMultiplexer(spawn.exec);
  const launchArgv = ["claude", "--model", "opus"];
  await mux.sessions!.spawnDetached({
    name: "api",
    cwd: "/w/api",
    argv: launchArgv,
    sidePane: false,
  });
  assert.deepEqual(spawn.calls[0]!.args.slice(-2), ["--", shellCommand(launchArgv)]);

  await mux.sessions!.rename("api", "-wip");
  assert.deepEqual(spawn.calls.at(-1)!.args.slice(-2), ["--", "-wip"]);
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
  ]);
  assert.equal(calls[0]!.input, "\x1b[Z");

  // Omitting --no-paste is what makes it a bracketed paste, which is the only way a
  // multi-line prompt reaches a composer without submitting at every newline. Verified
  // against a real pane holding a byte recorder with bracketed-paste mode on: the stdin
  // form delivers `ESC[200~one\ntwo ESC[201~`, identical to what the argument form did.
  await wez.write!.paste!(EMU, "one\ntwo");
  assert.deepEqual(calls[1]!.args, ["cli", "--no-auto-start", "send-text", "--pane-id", "5"]);
  assert.equal(calls[1]!.input, "one\ntwo");
});

test("a tmux write stops at the buffer it could not load", async () => {
  // The buffer and the paste are two commands, and the caller's whole retry decision turns
  // on whether text reached the pane. A failed load-buffer must not be followed by a paste -
  // that is what keeps "reported failure" meaning "the composer was not touched", which
  // `injectPrompt` reads to decide whether re-pasting would append a second copy.
  for (const verb of ["text", "paste"] as const) {
    const { calls, exec } = recorder([stubRun({ stdout: "", stderr: "no space", code: 1 })]);
    const tmux = tmuxMultiplexer(exec);
    const res = await (verb === "text" ? tmux.write.text(MUX, "body") : tmux.write.paste!(MUX, "body"));

    assert.equal(res.ok, false);
    assert.equal(res.error, "no space");
    assert.equal(calls.length, 1, `${verb} must not paste after a failed load`);
    assert.equal(calls[0]!.args[0], "load-buffer");
  }
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
  assert.equal(res.error, "tmux load-buffer failed");
});

test("a detached session gets its shell pane, and the session survives a failed split", async () => {
  const { calls, exec } = recorder([
    stubRun({ stdout: "", stderr: "", code: 0 }),
    stubRun({ stdout: "", stderr: "no room", code: 1 }),
  ]);
  const argv = ["pi", "--session-id", "pi-id", "it's $HOME; $(printf injected)\nnext"];
  const res = await tmuxMultiplexer(exec).sessions!.spawnDetached({
    name: "api",
    cwd: "/w/api",
    argv,
    sidePane: true,
  });

  // The split is a convenience; the session is what was asked for.
  // One shell-encoded command preserves argv boundaries on tmux before and after 3.3.
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0]!.args, [
    "new-session",
    "-d",
    "-s",
    "api",
    "-c",
    "/w/api",
    "--",
    shellCommand(argv),
  ]);
  assert.equal(calls[1]!.args[0], "split-window");
});

test("the argv that attaches a terminal honours the resolved binary", () => {
  // This argv is handed to an emulator to spawn, so it is the one place a binary outside
  // PATH has to be spelled out rather than assumed - a bare "tmux" here would ignore the
  // spec the adapter already carries.
  assert.deepEqual(tmuxMultiplexer().sessions!.attachArgv!("api"), [
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
  const tmuxOut = [["api", "1", "agent", "%3", "42", "/dev/ttys028", "/w/api"].join(SEP), ""].join("\n");
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
  assert.deepEqual(parsePanes(`\n  \napi${SEP}1\n`), []);
  assert.deepEqual(parseClients("nosep\n"), []);
  assert.deepEqual(parseEmulatorPanes("<html>not json</html>"), []);
  assert.deepEqual(parseEmulatorPanes('{"panes":[]}'), [], "an object is not the array we asked for");
});

test("a client with no tty is dropped rather than joined against every pane that has none", () => {
  assert.deepEqual(parseClients(`/dev/ttys028${SEP}api`), [{ tty: "ttys028", session: "api" }]);
  assert.deepEqual(parseClients(`${SEP}api`), []);
});

test("the pane format separator is printable, or tmux enumerates nothing at all", () => {
  // A regression guard on a bug that produced no error and no partial read - zero panes, on
  // two of the three tmux versions measured, which meant every tmux session on the machine
  // went uncarded and every agent on a tty was discovered with no pane to write to.
  //
  // The separator was `\x1f`, the ASCII unit separator - exactly the byte you would pick,
  // and the one tmux will not carry:
  //
  //   * tmux 3.3a (Debian 12) with a non-UTF-8 client locale strips non-printable bytes out
  //     of argv, and a `-F` format string IS argv, so every `\x1f` reached the server as `_`.
  //   * tmux 3.4 (Ubuntu 24.04, the current LTS) returns it ESCAPED, as the four literal
  //     characters `\037`, at every locale.
  //   * tmux 3.6b (macOS, homebrew) passes it through, which is why no developer saw this.
  //
  // Asserting the separator is printable is the whole guard: both failure modes are things
  // tmux does to non-printable bytes and to nothing else.
  assert.ok(SEP.length > 0);
  for (const ch of SEP) {
    const code = ch.codePointAt(0)!;
    assert.ok(
      code > 0x20 && code < 0x7f,
      `tmux mangles non-printable bytes in a -F format; ${JSON.stringify(ch)} is not printable ASCII`,
    );
  }
});

test("a field containing the separator drops its pane rather than misaddressing a write", () => {
  // The cost of a printable separator: it is no longer a byte a field cannot contain. A
  // window name is whatever the shell reports, so `~|~` in one would shift every field after
  // it - and field 3 is `paneId`, which is what every keystroke is addressed to. A shifted
  // line would send an operator's Escape, or their prompt, to a pane named by a fragment of
  // somebody else's window title.
  //
  // So the parse validates instead of trusting, and drops what it cannot vouch for. One pane
  // missing from the fleet is a visible absence; one pane misaddressed is an invisible wrong.
  const shifted = ["api", "1", `weird${SEP}name`, "%3", "42", "/dev/ttys028", "/w/api"].join(SEP);
  assert.deepEqual(parsePanes(shifted), [], "a line whose pane id is not %<digits> is dropped");

  // And the control: the identical line without the collision parses, so the test above
  // fails for the collision rather than for the shape of the fixture.
  const clean = ["api", "1", "weird-name", "%3", "42", "/dev/ttys028", "/w/api"].join(SEP);
  assert.equal(parsePanes(clean).length, 1);
  assert.equal(parsePanes(clean)[0]!.paneId, "%3");
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
