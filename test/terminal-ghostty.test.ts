// What is at stake: the acceptance test for the emulator axis, and the corrections it forced.
//
// Ghostty was queued as the pole opposite wezterm - the backend that "can be launched into
// and neither enumerated nor captured nor typed into". Pointed at a real install, three of
// those four claims were false (`todo/ghostty-emulator.md`). What this file pins is
// therefore not "the null path works" but the two things that actually turned out to be
// true: the nulls that survived contact with the app, and the AppleScript this adapter emits.
//
// Asserted against a fake exec for the reason `terminal-adapters.test.ts` gives - the
// interesting property of an adapter is what it emits, and a test that drives the real
// Ghostty asserts that on one machine and nothing everywhere else. The scripts below were
// each verified once against the live app by recording raw bytes off a pty; what these
// assertions protect is that nobody edits them into something that was never measured.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { GHOSTTY_BIN, binPresent, resolveBin } from "../src/server/terminal/bin.ts";
import { asQuote, ghosttyEmulator, parseSurfaces } from "../src/server/terminal/ghostty.ts";
import { ALL_KEYS } from "../src/server/terminal/types.ts";

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

const TARGET = { paneId: "9F022DDA-3FD6-42AB-8388-D35E74B22ADA", tabId: "tab-bd55d7600" };
const US = "";
const RS = "";

/** The script of the only call made, which is what every write assertion is really about. */
function onlyScript(calls: Call[]): string {
  assert.equal(calls.length, 1, "one osascript invocation per write");
  assert.equal(calls[0]!.bin, "/usr/bin/osascript");
  assert.equal(calls[0]!.args[0], "-e");
  return calls[0]!.args[1]!;
}

test("the capabilities it declares, and the two nulls that survived a real install", () => {
  const g = ghosttyEmulator();

  // Not null, against the plan's prediction. Each of these was driven against Ghostty 1.3.1.
  assert.ok(g.list, "Ghostty enumerates - its AppleScript dictionary lists windows/tabs/surfaces");
  assert.ok(g.write, "and types");
  assert.ok(g.write?.paste, "and pastes, which is what makes a multi-line prompt deliverable");
  assert.ok(g.spawn, "and spawns");

  // Genuinely absent, each pointed at the dictionary before being declared.
  assert.equal(g.capture, null, "no property or command returns screen text");
  assert.equal(g.retitle, null, "`name` is access=r on window, tab and terminal alike");

  // The interface guessed low: `granularity: "app"` was added FOR Ghostty on the assumption
  // it could only be brought forward wholesale. It focuses one surface.
  assert.equal(g.focus?.granularity, "pane");

  // The slot this adapter forced onto the interface, and the reason it is not decorative.
  assert.deepEqual(g.hostProcess, { commands: ["ghostty"] });
});

test("the binary answers 'is it installed' and is never the thing that runs", async () => {
  // The first backend where those are two different binaries. `+new-window` answers "not
  // supported on this platform" and the bundle is built `app runtime: .none`, so the GUI is
  // driven by Apple Events - and `binPresent` still needs a real path to test.
  assert.equal(resolveBin(GHOSTTY_BIN), "/Applications/Ghostty.app/Contents/MacOS/ghostty");
  assert.equal(GHOSTTY_BIN.env, "GHOSTTY_BIN");

  // No bare PATH candidate, deliberately: `ghostty` is normally absent from PATH on macOS
  // and normally PRESENT on Linux, where the AppleScript this adapter depends on does not
  // exist. A bare candidate would report "installed" on exactly the platform where every
  // call must fail.
  assert.equal(GHOSTTY_BIN.candidates.includes("ghostty"), false);
  assert.equal(binPresent({ ...GHOSTTY_BIN, env: null, candidates: ["/nope/ghostty"] }), false);

  const { calls, exec } = recorder();
  await ghosttyEmulator(exec).list!();
  assert.equal(calls[0]?.bin, "/usr/bin/osascript", "the adapter runs osascript, not ghostty");
});

test("every key renders into Ghostty's own convention, which is a third one", async () => {
  // tmux takes names, wezterm takes escape sequences, and Ghostty takes BOTH through two
  // different commands - which is precisely the case `Key` exists for. Verified by recording
  // pty bytes: `send key` accepts a small table of named specials and silently does NOTHING
  // for a plain character, while `up` / `arrow_up` / `page_up` are all rejected outright.
  const expected: Record<string, string> = {
    enter: 'send key "enter"',
    up: 'perform action "csi:A"',
    down: 'perform action "csi:B"',
    left: 'perform action "csi:D"',
    right: 'perform action "csi:C"',
    "shift-up": 'perform action "csi:1;2A"',
    "shift-down": 'perform action "csi:1;2B"',
    "shift-tab": 'perform action "csi:Z"',
  };

  for (const key of ALL_KEYS) {
    const { calls, exec } = recorder();
    await ghosttyEmulator(exec).write!.keys(TARGET, [key]);
    const script = onlyScript(calls);
    assert.ok(
      script.includes(expected[key]!),
      `${key} must render as ${expected[key]} - got: ${script}`,
    );
    assert.ok(script.includes(TARGET.paneId), `${key} must address the surface it was given`);
  }
});

test("text types literally with newlines SUBMITTING, assembled from two primitives", async () => {
  // Neither primitive does this alone, and picking either one would be a silent correctness
  // bug. `input text` is a real bracketed paste (measured arriving inside ESC[200~/ESC[201~),
  // so a newline inside it does not submit. `perform action "text:…"` types literally and
  // INTERPRETS BACKSLASH ESCAPES - `text:a\nb` was measured arriving as a<LF>b - so a reply
  // containing a literal backslash-n would submit itself halfway through.
  const { calls, exec } = recorder();
  await ghosttyEmulator(exec).write!.text(TARGET, "first\nsecond");
  const script = onlyScript(calls);

  assert.ok(script.includes('input text "first"'));
  assert.ok(script.includes('input text "second"'));
  assert.ok(script.includes('send key "enter"'), "the newline must become a real Enter");
  assert.ok(
    script.indexOf('input text "first"') <
      script.indexOf('send key "enter"') &&
      script.indexOf('send key "enter"') < script.indexOf('input text "second"'),
    "order must be body, Enter, body - anything else reorders the operator's input",
  );
  // The unsafe path must never appear on a body: it is the one that rewrites backslashes.
  assert.equal(script.includes("perform action \"text:"), false);
});

test("a body starting with a dash reaches the surface untouched", async () => {
  // tmux and wezterm both need a `--` terminator here because their CLIs parse trailing
  // arguments as flags. Ghostty needs none: an AppleScript string is not an argv, so there is
  // no parser to escape from. Pinned because the absence of a terminator reads like an
  // oversight next to the other two adapters.
  const { calls, exec } = recorder();
  await ghosttyEmulator(exec).write!.text(TARGET, "-v is what broke it");
  assert.ok(onlyScript(calls).includes('input text "-v is what broke it"'));
});

test("quoting closes the only two characters an AppleScript string cares about", () => {
  assert.equal(asQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(asQuote("back\\slash"), '"back\\\\slash"');
  // A literal newline cannot sit inside an AppleScript string at all. `text` never sends one
  // through here - it splits first - so this is the belt for every other caller.
  assert.equal(asQuote("a\nb"), '"a\\nb"');
});

test("paste is one bracketed block, not the line-by-line path", async () => {
  // The distinction `PaneWrite` is built on: a multi-line prompt must reach the composer as
  // one block rather than being shredded into a submission per line.
  const { calls, exec } = recorder();
  await ghosttyEmulator(exec).write!.paste!(TARGET, "line one\nline two");
  const script = onlyScript(calls);
  assert.ok(script.includes('input text "line one\\nline two"'));
  assert.equal(script.includes('send key "enter"'), false, "a paste submits nothing");
});

test("surfaces parse with tty ALWAYS null, which is the finding and not an oversight", () => {
  const out =
    ["UUID-A", "tab-1", "win-1", "alpha", "Alpha Window", "/w/alpha", "1"].join(US) +
    RS +
    ["UUID-B", "tab-2", "win-2", "beta", "Beta Window", "", "0"].join(US) +
    RS;
  const panes = parseSurfaces(out);
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[0], {
    paneId: "UUID-A",
    tabId: "tab-1",
    windowId: "win-1",
    tabTitle: "alpha",
    windowTitle: "Alpha Window",
    isActive: true,
    tty: null,
    cwd: "/w/alpha",
  });
  // An empty working directory is a real state, not a parse failure: a surface spawned with a
  // raw command never runs shell integration, so OSC 7 is never emitted. It becomes null so
  // the cwd correlation key simply has nothing to offer rather than matching on "".
  assert.equal(panes[1]?.cwd, null);
  assert.equal(panes[1]?.isActive, false);
});

test("unparseable output enumerates as [], the same answer as 'not running'", () => {
  // Matches `parsePanes` in wezterm.ts: a caller has no more to do with half a pane list than
  // with none, and discovery must degrade silently on a machine that is not running this.
  assert.deepEqual(parseSurfaces(""), []);
  assert.deepEqual(parseSurfaces("   "), []);
  assert.deepEqual(parseSurfaces("some AppleScript error text"), []);
  // Short of the seven fields the script emits: the format changed, and guessing which field
  // is which would put a window title in a cwd.
  assert.deepEqual(parseSurfaces(["UUID-A", "tab-1"].join(US) + RS), []);
});

test("a failed list is [] rather than an error a card could not act on", async () => {
  // Covers both states this must pass through quietly: Ghostty not running, and Automation
  // permission not granted (osascript exits non-zero with -1743). Neither is actionable from
  // a session card and both resolve themselves.
  const { exec } = recorder([stubRun({ stdout: "", stderr: "-1743", code: 1 })]);
  assert.deepEqual(await ghosttyEmulator(exec).list!(), []);
});

test("spawn splits 'a window opened' from 'we can address it'", async () => {
  // `SpawnResult`'s whole reason to exist, and Ghostty is what it was written for.
  const ok = recorder([stubRun({ stdout: `UUID-NEW${US}tab-NEW`, stderr: "", code: 0 })]);
  const made = await ghosttyEmulator(ok.exec).spawn!.tab({
    argv: ["/bin/zsh", "-l"],
    title: "ignored",
    cwd: null,
  });
  assert.equal(made.ok, true);
  assert.deepEqual(made.target, { paneId: "UUID-NEW", tabId: "tab-NEW" });

  // Exit 0 with nothing readable back: the human got their window and nothing may be typed
  // into it. `ok: true` with a null target is a complete answer, not a failure.
  const mute = recorder([stubRun({ stdout: "", stderr: "", code: 0 })]);
  const quiet = await ghosttyEmulator(mute.exec).spawn!.tab({
    argv: ["/bin/zsh"],
    title: "t",
    cwd: null,
  });
  assert.equal(quiet.ok, true);
  assert.equal(quiet.target, null);

  // A spawn that failed opened nothing to address.
  const bad = recorder([stubRun({ stdout: "", stderr: "boom", code: 1 })]);
  const failed = await ghosttyEmulator(bad.exec).spawn!.tab({
    argv: ["/bin/zsh"],
    title: "t",
    cwd: null,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.target, null);
});

test("a spawn asked for a cwd roots the surface there, never somewhere else", async () => {
  // `TabSpec.cwd` is the one field an emulator may not quietly drop: the focus fallback can
  // land wherever the session already is, but a DISPATCH must root the agent in the worktree
  // just cut for it, and an agent in the wrong checkout commits to the wrong branch.
  // Ghostty can honour it - `surface configuration` carries `initial working directory` - so
  // what this pins is that it is actually sent rather than silently omitted.
  const { calls, exec } = recorder([stubRun({ stdout: `UUID-A${US}tab-A`, stderr: "", code: 0 })]);
  await ghosttyEmulator(exec).spawn!.tab({
    argv: ["/bin/zsh", "-l", "it's $HOME; $(printf injected)\nnext"],
    title: "t",
    cwd: "/w/alpha",
  });
  const script = onlyScript(calls);
  assert.ok(script.includes('set initial working directory of cfg to "/w/alpha"'));
  assert.ok(
    script.includes(
      `set command of cfg to "'/bin/zsh' '-l' 'it'\\"'\\"'s $HOME; $(printf injected)\\nnext'"`,
    ),
  );

  // And no cwd asked for means the key is absent entirely, not set to an empty string -
  // which Ghostty would read as a directory and refuse.
  const none = recorder([stubRun({ stdout: `UUID-B${US}tab-B`, stderr: "", code: 0 })]);
  await ghosttyEmulator(none.exec).spawn!.tab({ argv: ["/bin/zsh"], title: "t", cwd: null });
  assert.equal(onlyScript(none.calls).includes("initial working directory"), false);
});

test("a killed write is reported as outcome-unknown, never as a clean refusal", async () => {
  // `TerminalResult.outcomeUnknown` deciding something, as it does for tmux and wezterm: a
  // write that died rather than answering may already be sitting in the composer, and
  // re-sending onto it appends a second copy of the operator's prompt.
  // Built directly rather than through `stubRun`, which hardcodes the flag to false - the
  // whole point here is the value it pins.
  const { exec } = recorder([
    { stdout: "", stderr: "", code: 1, outcomeUnknown: true, overflowed: false },
  ]);
  const r = await ghosttyEmulator(exec).write!.text(TARGET, "hello");
  assert.equal(r.ok, false);
  assert.equal(r.outcomeUnknown, true);
});

test("focus raises the app and the surface, addressed by bundle id", async () => {
  const { calls, exec } = recorder();
  const focus = ghosttyEmulator(exec).focus!;
  assert.equal(focus.granularity, "pane");
  await (focus as { raise(t: typeof TARGET): Promise<unknown> }).raise(TARGET);
  const script = onlyScript(calls);
  assert.ok(script.includes("activate"), "the app has to come forward");
  assert.ok(script.includes("focus "), "and the specific surface has to be selected");
  assert.ok(script.includes(TARGET.paneId));
  // By bundle id, never by application NAME: a name resolves to whatever app is called that.
  assert.ok(script.includes('application id "com.mitchellh.ghostty"'));
});
