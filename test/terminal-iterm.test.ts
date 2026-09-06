import assert from "node:assert/strict";
import test from "node:test";

import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { appleScriptString, appleScriptText } from "../src/server/terminal/applescript.ts";
import { binPresent, ITERM_BIN, resolveBin } from "../src/server/terminal/bin.ts";
import {
  executableCandidateContext,
  executableSpec,
} from "../src/server/executables/catalog.ts";
import { itermEmulator, parseItermSessions } from "../src/server/terminal/iterm.ts";
import { ALL_KEYS, type Key } from "../src/server/terminal/types.ts";

interface Call {
  bin: string;
  args: string[];
  input?: string;
  timeoutMs?: number;
}

function recorder(results: RunResult[] = []) {
  const calls: Call[] = [];
  let index = 0;
  const exec = async (
    bin: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ): Promise<RunResult> => {
    calls.push({ bin, args, input: opts?.input, timeoutMs: opts?.timeoutMs });
    return results[index++] ?? stubRun({ stdout: "", stderr: "", code: 0 });
  };
  return { calls, exec };
}

const US = "\x1f";
const RS = "\x1e";
const TARGET = { paneId: "w0t2p1:52C60FCA-8285-4B97-A87E-4D2EA9859F87", tabId: "mutable-7" };

function onlyScript(calls: Call[]): string {
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.bin, "/usr/bin/osascript");
  assert.deepEqual(call.args, [], "AppleScript and payloads belong on standard input");
  assert.ok(call.input);
  return call.input!;
}

test("declares the complete iTerm2 capability surface and passive host gate", () => {
  const backend = itermEmulator();
  assert.equal(backend.id, "iterm");
  assert.equal(backend.label, "iTerm2");
  assert.ok(backend.list);
  assert.ok(backend.write);
  assert.ok(backend.write?.paste);
  assert.ok(backend.capture);
  assert.equal(backend.focus?.granularity, "pane");
  assert.ok(backend.spawn);
  assert.ok(backend.retitle);
  assert.deepEqual(backend.hostProcess, { commands: ["iTerm2"] });
});

test("detects only the configured app bundle without a PATH fallback", () => {
  const declared = executableSpec("iterm");
  assert.equal(declared.overrideEnv, "ITERM_BIN");
  assert.equal(declared.searchPath, false);
  assert.deepEqual(declared.candidates(executableCandidateContext()), [
    "/Applications/iTerm.app/Contents/MacOS/iTerm2",
    `${process.env.HOME}/Applications/iTerm.app/Contents/MacOS/iTerm2`,
  ]);
  assert.equal(
    resolveBin({
      env: null,
      candidates: ["/Applications/iTerm.app/Contents/MacOS/iTerm2"],
      dropEnv: [],
    }),
    "/Applications/iTerm.app/Contents/MacOS/iTerm2",
  );
  assert.equal(
    binPresent({ env: null, candidates: ["/nope/iTerm2"], dropEnv: [] }),
    false,
  );
});

test("enumerates every window, tab, and session through one stdin script", async () => {
  const encoded = [
    "w0t0p0:UUID%25A",
    "2",
    "91",
    "api%1Fworker",
    "Window%1EOne",
    "/dev/ttys028",
    "file:///tmp/work%20tree",
    "1",
  ].join(US) + RS;
  const run = recorder([stubRun({ stdout: encoded, stderr: "", code: 0 })]);
  const panes = await itermEmulator(run.exec).list!();
  assert.deepEqual(panes, [{
    paneId: "w0t0p0:UUID%A",
    tabId: "2",
    windowId: "91",
    tabTitle: `api${US}worker`,
    windowTitle: `Window${RS}One`,
    isActive: true,
    tty: "ttys028",
    cwd: "/tmp/work tree",
  }]);
  const script = onlyScript(run.calls);
  assert.match(script, /repeat with terminalWindow in windows/);
  assert.match(script, /repeat with terminalTab in tabs of terminalWindow/);
  assert.match(script, /repeat with terminalSession in sessions of terminalTab/);
  assert.match(script, /variable terminalSession named "path"/);
  assert.match(script, /on readItermTabTitle\(terminalTab\)/);
  assert.match(script, /return title of terminalTab as text/);
  assert.match(script, /return name of current session of terminalTab as text/);
  assert.match(script, /set terminalTabTitle to my readItermTabTitle\(terminalTab\)/);
  assert.match(script, /my encodeField\(terminalTabTitle\)/);
});

test("rejects malformed records and normalizes missing optional fields", () => {
  assert.deepEqual(parseItermSessions("not-a-record"), []);
  assert.deepEqual(parseItermSessions(["bad id with spaces", "1", "2", "", "", "", "", "0"].join(US) + RS), []);
  assert.deepEqual(parseItermSessions(["session", "1", "2", "", "", "", "", "x"].join(US) + RS), []);
  assert.deepEqual(parseItermSessions(["session", "1", "2", "", "", "", "", "0"].join(US) + RS)[0], {
    paneId: "session",
    tabId: "1",
    windowId: "2",
    tabTitle: "",
    windowTitle: "",
    isActive: false,
    tty: null,
    cwd: null,
  });
});

test("list failures stay local to iTerm2", async () => {
  for (const failure of [
    stubRun({ stdout: "", stderr: "Not authorized to send Apple events. (-1743)", code: 1 }),
    { stdout: "", stderr: "timed out", code: 1, outcomeUnknown: true, overflowed: false },
  ]) {
    const run = recorder([failure]);
    assert.deepEqual(await itermEmulator(run.exec).list!(), []);
  }
});

test("literal text uses exact session traversal and submits embedded newlines", async () => {
  const run = recorder();
  await itermEmulator(run.exec).write!.text(TARGET, "first\nsecond");
  const script = onlyScript(run.calls);
  assert.match(script, /id of candidateSession as text\) is targetId/);
  assert.ok(script.includes(appleScriptString(TARGET.paneId)));
  assert.equal(script.includes(TARGET.tabId), false, "a mutable tab index must never target an action");
  const first = script.indexOf('write targetSession text ("first") newline no');
  const enter = script.indexOf("write targetSession text (character id 13) newline no");
  const second = script.indexOf('write targetSession text ("second") newline no');
  assert.ok(first >= 0 && first < enter && enter < second);
});

test("literal text treats CRLF as one submission and preserves standalone carriage returns", async () => {
  const run = recorder();
  await itermEmulator(run.exec).write!.text(TARGET, "first\r\nsecond");
  const script = onlyScript(run.calls);
  const first = script.indexOf('write targetSession text ("first") newline no');
  const newline = script.indexOf("write targetSession text (character id 13) newline no");
  const second = script.indexOf('write targetSession text ("second") newline no');
  assert.ok(first >= 0 && first < newline && newline < second);
  assert.equal(script.match(/character id 13/g)?.length, 1, "one CRLF line ending must submit exactly once");
  assert.equal(script.includes("\\r"), false, "carriage returns must not become literal backslash-r text");

  const standalone = recorder();
  await itermEmulator(standalone.exec).write!.text(TARGET, "first\rsecond");
  const standaloneScript = onlyScript(standalone.calls);
  assert.ok(standaloneScript.includes('write targetSession text ("first" & (character id 13) & "second") newline no'));
  assert.equal(standaloneScript.match(/character id 13/g)?.length, 1);
});

test("every shared key has an explicit iTerm2 byte expression", async () => {
  const expected: Record<Key, string> = {
    enter: "character id 13",
    escape: "character id 27",
    up: '(character id 27) & "[A"',
    down: '(character id 27) & "[B"',
    left: '(character id 27) & "[D"',
    right: '(character id 27) & "[C"',
    tab: "character id 9",
    "shift-up": '(character id 27) & "[1;2A"',
    "shift-down": '(character id 27) & "[1;2B"',
    "shift-tab": '(character id 27) & "[Z"',
  };
  for (const key of ALL_KEYS) {
    const run = recorder();
    await itermEmulator(run.exec).write!.keys(TARGET, [key]);
    assert.ok(onlyScript(run.calls).includes(expected[key]), key);
  }
});

test("multi-line and long prompts travel once through stdin as bracketed paste", async () => {
  const longLine = "x".repeat(200_000);
  const body = `line one\n${longLine}\rline three\r\nline four`;
  const run = recorder();
  await itermEmulator(run.exec).write!.paste!(TARGET, body);
  const script = onlyScript(run.calls);
  assert.ok(script.includes('character id 27) & "[200~"'));
  assert.ok(script.includes('character id 27) & "[201~"'));
  assert.ok(script.includes('"line one" & (character id 10) & "'));
  assert.ok(script.includes(`"${longLine}" & (character id 13) & "line three" & (character id 13) & (character id 10) & "line four"`));
  assert.equal(script.includes("\\n"), false, "line feeds must not become literal backslash-n text");
  assert.equal(script.includes("\\r"), false, "carriage returns must not become literal backslash-r text");
  assert.equal(script.match(/write targetSession text/g)?.length, 1, "the complete prompt must remain one bracketed-paste write");
  assert.ok(script.length > body.length);
  assert.deepEqual(run.calls[0]!.args, []);
});

test("captures visible contents and returns null on a stale or denied target", async () => {
  const ok = recorder([stubRun({ stdout: "visible shell\n", stderr: "", code: 0 })]);
  assert.equal(await itermEmulator(ok.exec).capture!(TARGET), "visible shell\n");
  assert.match(onlyScript(ok.calls), /return contents of targetSession/);

  const stale = recorder([stubRun({ stdout: "", stderr: "iTerm2 session no longer exists (-1728)", code: 1 })]);
  assert.equal(await itermEmulator(stale.exec).capture!(TARGET), null);
});

test("focus selects the exact window, tab, and session before activation", async () => {
  const run = recorder();
  const focus = itermEmulator(run.exec).focus!;
  assert.equal(focus.granularity, "pane");
  await (focus as { raise(target: typeof TARGET): Promise<unknown> }).raise(TARGET);
  const script = onlyScript(run.calls);
  const windowAt = script.indexOf("select targetWindow");
  const tabAt = script.indexOf("select targetTab");
  const sessionAt = script.indexOf("select targetSession");
  const activateAt = script.indexOf("activate");
  assert.ok(windowAt >= 0 && windowAt < tabAt && tabAt < sessionAt && sessionAt < activateAt);
});

test("retitle changes the containing tab found by session id", async () => {
  const run = recorder();
  await itermEmulator(run.exec).retitle!(TARGET, 'release "candidate"');
  const script = onlyScript(run.calls);
  assert.match(script, /on setItermTabTitle\(terminalTab, requestedTitle\)/);
  assert.ok(script.includes('set title of terminalTab to requestedTitle'));
  assert.ok(script.includes('set name of current session of terminalTab to requestedTitle'));
  assert.ok(script.includes('my setItermTabTitle(targetTab, "release \\"candidate\\"")'));
  assert.equal(script.includes(TARGET.tabId), false);
});

test("spawn preserves cwd and argv boundaries, stamps title, and returns the new target", async () => {
  const result = `w0t4p0:NEW-ID${US}4\n`;
  const run = recorder([stubRun({ stdout: result, stderr: "", code: 0 })]);
  const spawned = await itermEmulator(run.exec).spawn!.tab({
    cwd: "/tmp/work tree; $(not-run)",
    argv: ["/bin/zsh", "-l", "it's $HOME; echo nope"],
    title: "feature tab",
  });
  assert.deepEqual(spawned, {
    ok: true,
    outcomeUnknown: false,
    target: { paneId: "w0t4p0:NEW-ID", tabId: "4" },
  });
  const script = onlyScript(run.calls);
  assert.ok(script.includes("cd -- '/tmp/work tree; $(not-run)' && exec '/bin/zsh' '-l' 'it'\\\"'\\\"'s $HOME; echo nope'"));
  assert.ok(script.includes('my setItermTabTitle(newTab, "feature tab")'));
  assert.ok(script.includes('set name of current session of terminalTab to requestedTitle'));
});

test("definite, permission, and timeout failures retain their delivery semantics", async () => {
  const stale = recorder([stubRun({ stdout: "", stderr: "iTerm2 session no longer exists (-1728)", code: 1 })]);
  const staleResult = await itermEmulator(stale.exec).write!.text(TARGET, "hello");
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.outcomeUnknown, false);
  assert.match(staleResult.error ?? "", /no longer exists/);

  const denied = recorder([stubRun({ stdout: "", stderr: "Not authorized to send Apple events. (-1743)", code: 1 })]);
  const deniedResult = await itermEmulator(denied.exec).write!.text(TARGET, "hello");
  assert.match(deniedResult.error ?? "", /System Settings > Privacy & Security > Automation/);

  const timedOut = recorder([{ stdout: "", stderr: "timed out", code: 1, outcomeUnknown: true, overflowed: false }]);
  const timeoutResult = await itermEmulator(timedOut.exec).write!.text(TARGET, "hello");
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.outcomeUnknown, true);
});

test("AppleScript string quoting escapes quotes, slashes, and control characters in source", () => {
  assert.equal(appleScriptString('say "hi"'), '"say \\"hi\\""');
  assert.equal(appleScriptString("back\\slash"), '"back\\\\slash"');
  assert.equal(appleScriptString("a\nb\r"), '"a\\nb\\r"');
});

test("AppleScript text expressions preserve line-feed and carriage-return bytes", () => {
  assert.equal(
    appleScriptText("a\nb\rc\r\nd"),
    '"a" & (character id 10) & "b" & (character id 13) & "c" & (character id 13) & (character id 10) & "d"',
  );
  assert.equal(appleScriptText("\n\r"), "(character id 10) & (character id 13)");
  assert.equal(appleScriptText(""), '""');
});
