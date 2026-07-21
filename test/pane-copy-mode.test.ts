import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  injectPrompt,
  selectPaneOption,
  sendText,
  type InjectDeps,
  type PaneDeps,
} from "../src/server/actions.ts";
import { bindSession } from "../src/server/terminal/registry.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";
import { readTmuxPaneMode } from "../src/server/terminal/tmux.ts";
import { run, stubRun, type RunResult } from "../src/server/util/exec.ts";
import type { Session } from "@shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// A tmux pane in copy-mode routes every key to tmux's OWN key table. `send-keys` and
// `paste-buffer` both still exit 0, and the child receives NOTHING - so the daemon's only
// evidence of delivery (the exit code) says "landed" for a keystroke that was thrown away.
//
// The bug being pinned is what that lie costs upstream. Foreman stamps a prompt handled
// only once the send succeeds, so a swallowed answer marks the question ANSWERED, the
// idempotency check then refuses to retry it, and the session sits in "Needs You" forever
// underneath a note claiming it was already answered. Observed in the wild: a session was
// asked a question at 10:17:29, Foreman "answered: option 1" at 10:18:42, and the menu was
// still on screen with the cursor parked on option 1 - untouched, because the pane had
// been left in copy-mode. It emitted no further events, so nothing ever moved it out of
// `awaiting_input`.
//
// The fix is to refuse rather than to cancel the mode: copy-mode is a PERSON reading their
// own scrollback, and a refusal is a no-op the caller retries once they leave.

const tmuxSession = (paneId = "%1"): Session =>
  ({ id: "s1", agent: "claude", terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId })] }) as Session;

const ok = (stdout: string): RunResult => stubRun({ stdout, stderr: "", code: 0 });

/**
 * Answer the mode probe with `inMode`, and record everything else that was attempted.
 *
 * `screen` is what a pane read returns, which is what makes the MENU writers drivable
 * here: `selectPaneOption` reads the dialog off the pane before it touches a key, so
 * without a screen showing one it refuses for want of a menu and never reaches the
 * guard at all - an assertion that passes whether or not the guard exists.
 */
function harness(inMode: string, mode = "copy-mode", screen = ""): { deps: InjectDeps; argv: string[] } {
  const argv: string[] = [];
  // The REAL tmux adapter, built on a fake subprocess. Faking the pane itself would assert
  // that the policy asks its questions in the right order and nothing about the argv those
  // questions turn into - and the argv is half the claim here, since "nothing was written"
  // is only a fact about commands that were never run.
  const exec: TerminalExec = async (bin, args) => {
    const line = [bin, ...args].join(" ");
    if (args.includes("display-message")) return ok(`${inMode} ${mode}`);
    argv.push(line);
    return ok("");
  };
  return {
    argv,
    deps: {
      pane: (session) => bindSession(session, exec),
      capture: async () => screen,
      sleep: async () => {},
    },
  };
}

/** The `PaneDeps` half, for the writers that need no clock. */
const paneDeps = (h: { deps: InjectDeps }): PaneDeps => ({ pane: h.deps.pane, capture: h.deps.capture });

/** A menu on screen, in the shape `parsePaneDialog` reads, with the cursor on `cursor`. */
const menu = (cursor: number): string =>
  ["Which way should this go?", "", ...["Ship it", "Hold it"].map((label, i) => `${cursor === i + 1 ? "❯" : " "} ${i + 1}. ${label}`)].join("\n");

// ---- the probe ----

test("the probe reads a mode only from an explicit in-mode flag", async () => {
  const probe = (out: string, code = 0) =>
    readTmuxPaneMode("%1", async () => stubRun({ stdout: out, stderr: "", code }));

  assert.equal(await probe("1 copy-mode"), "copy-mode");
  assert.equal(await probe("1 view-mode"), "view-mode");
  assert.equal(await probe("0 "), null, "a pane in no mode takes keystrokes normally");
});

test("a probe that cannot answer reads as 'not in a mode', not as 'blocked'", async () => {
  // Deliberately fail-open, and the one place in this fix that does. A tmux too old to
  // know these formats, a dead pane, or no server at all would otherwise refuse EVERY
  // write on the machine - a total outage, traded for the single swallowed keystroke this
  // guard exists to catch. Absence of evidence is not evidence of copy-mode.
  const probe = (out: string, code = 0) =>
    readTmuxPaneMode("%1", async () => stubRun({ stdout: out, stderr: "", code }));

  assert.equal(await probe("", 1), null, "no such pane / no tmux server");
  assert.equal(await probe(""), null, "empty output");
  assert.equal(await probe("#{pane_in_mode}"), null, "a tmux that left the format unexpanded");
});

test("a pane in a mode tmux won't name is still refused", async () => {
  // `pane_mode` predates neither flag on every tmux; an empty name must not read as "free".
  const mode = await readTmuxPaneMode("%1", async () => ok("1 "));
  assert.ok(mode, "in-mode with no name is still in a mode");
});

// ---- the writers ----

test("a prompt is not pasted into a pane in copy-mode, and does not claim it was", async () => {
  const { deps, argv } = harness("1");
  const r = await injectPrompt(tmuxSession(), "do the thing", deps);

  assert.equal(r.ok, false);
  assert.equal(r.pasted, false, "the caller must not be told the text is sitting in the pane");
  assert.match(r.error ?? "", /copy-mode/, "the error names the mode so a human can clear it");
  assert.deepEqual(argv, [], "nothing was written to the pane at all");
});

test("the refusal tells the human how to unblock it", async () => {
  const { deps } = harness("1");
  const r = await injectPrompt(tmuxSession(), "x", deps);
  assert.match(r.error ?? "", /nothing was sent/, "it says the write did NOT land");
});

test("a pane in no mode is written to exactly as before", async () => {
  const { deps, argv } = harness("0");
  const r = await injectPrompt(tmuxSession(), "do the thing", deps);

  assert.equal(r.ok, true);
  assert.equal(r.pasted, true);
  assert.ok(argv.some((a) => a.includes("paste-buffer")), "the paste still happens");
});

// Every writer below reaches the pane through the same `sendKeys` choke point, and each is
// asserted through the injected exec rather than a live tmux. The real-tmux case at the
// bottom is what proves the PREMISE (tmux really does swallow these), but it is skipped on
// a runner without tmux - so if these were left to it, a change that dropped the probe from
// `sendKeys` would go green on exactly the machines nobody is watching.

test("sendText is refused, and types nothing, when the pane is in a mode", async () => {
  const h = harness("1");
  const r = await sendText(tmuxSession(), "hello", true, paneDeps(h));

  assert.equal(r.ok, false);
  assert.equal(r.paneBlocked, true, "the caller can tell this from a broken send");
  assert.match(r.error ?? "", /copy-mode/);
  assert.deepEqual(h.argv, [], "neither the text nor the Enter was sent");
});

test("the Enter that answers a menu is refused when the pane is in a mode", async () => {
  // The production shape of the original bug: a real menu IS on screen with the cursor
  // already on the target row, so the walk is a no-op and Enter - the one irreversible
  // keystroke - is all that remains. Nothing but the guard can stop it here.
  const h = harness("1", "copy-mode", menu(1));
  const r = await selectPaneOption(tmuxSession(), { number: 1, label: "Ship it" }, paneDeps(h));

  assert.equal(r.ok, false);
  assert.equal(r.paneBlocked, true);
  assert.match(r.error ?? "", /copy-mode/, "the refusal names the mode, not a missing menu");
  assert.deepEqual(h.argv, [], "no Enter was pressed at a menu that would not have taken it");
});

test("the arrow that walks onto a menu row is refused when the pane is in a mode", async () => {
  // Cursor on row 1, target row 2: the first keystroke is an arrow, so this covers the
  // other half of the menu walk. An arrow commits nothing, but a swallowed one strands
  // the walk into pressing Enter on whatever row it wrongly believes it reached.
  const h = harness("1", "copy-mode", menu(1));
  const r = await selectPaneOption(tmuxSession(), { number: 2, label: "Hold it" }, paneDeps(h));

  assert.equal(r.ok, false);
  assert.equal(r.paneBlocked, true);
  assert.match(r.error ?? "", /copy-mode/);
  assert.deepEqual(h.argv, [], "not even an arrow was sent");
});

test("a menu on a pane in no mode is still answered normally", async () => {
  // The guard's counterpart: the three tests above must fail because of the MODE, not
  // because the harness can't answer a menu at all.
  const h = harness("0", "copy-mode", menu(1));
  const r = await selectPaneOption(tmuxSession(), { number: 1, label: "Ship it" }, paneDeps(h));

  assert.equal(r.ok, true);
  // `--` ends tmux's flag parsing and arrived with the adapter: the key name after it is
  // still resolved as a key, so this is the same keystroke it always was.
  assert.ok(h.argv.some((a) => a.includes("send-keys -t %1 -- Enter")), "the Enter still goes through");
});

test("an Enter swallowed AFTER the paste says so, and does not claim nothing happened", async () => {
  // The one refusal that is not a clean no-op. The pane is free when the prompt is
  // pasted and in copy-mode by the time the Enter goes, so the text really is sitting in
  // the composer - and a caller told `pasted: false` here would paste a second copy on
  // top of it. `pasted: true` is what routes it to a human instead.
  let pasted = false;
  const argv: string[] = [];
  const exec: TerminalExec = async (bin, args) => {
    if (args.includes("display-message")) return ok(pasted ? "1 copy-mode" : "0 ");
    if (args.includes("paste-buffer")) pasted = true;
    argv.push([bin, ...args].join(" "));
    return ok("");
  };
  const deps: InjectDeps = {
    pane: (session) => bindSession(session, exec),
    capture: async () => "",
    sleep: async () => {},
  };

  const r = await injectPrompt(tmuxSession(), "do the thing", deps);

  assert.equal(r.ok, false);
  assert.equal(r.pasted, true, "the text IS in the composer - re-pasting would double it");
  assert.equal(r.paneBlocked, true);
  assert.match(r.error ?? "", /unsubmitted/, "it says where the text actually is");
  assert.match(r.error ?? "", /copy-mode/, "and names the mode to clear");
  assert.ok(!argv.some((a) => a.includes("send-keys")), "no Enter was spent on a pane that would eat it");
});

// ---- against a real pane ----

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = tmuxAvailable() ? false : "tmux not available";

/** Run a tmux command with no locale at all, as a launchd daemon or a CI runner does. */
function noLocale(bin: string, args: string[]): Promise<RunResult> {
  const env = { ...process.env };
  delete env.LANG;
  delete env.LC_ALL;
  delete env.LC_CTYPE;
  return run(bin, args, { env });
}

test("a real pane in copy-mode swallows keystrokes that tmux reports as sent", { skip }, async () => {
  // The whole fix rests on a claim about tmux's behavior, not about our code: that
  // `send-keys` exits 0 while the child gets nothing. If that were ever false the guard
  // would be pointless, so it is asserted against a real tmux rather than assumed.
  const sessName = `mc-copymode-${process.pid}`;
  const tmux = (paneId: string) => mkMuxHandle({ session: sessName, windowName: "0", paneId });
  try {
    // A pane that appends every line it receives, so "did the child see it" is a fact on
    // disk rather than an inference from the screen. It paints a menu first, in the shape
    // `parsePaneDialog` reads, so the `selectPaneOption` case below has something real to
    // be refused at - see that assertion for why a menu-less pane would prove nothing.
    const sink = `/tmp/${sessName}.out`;
    // The `❯` is written as OCTAL, and both halves of that matter. It cannot be the
    // literal character: tmux strips non-ASCII out of its own argv when the locale isn't
    // UTF-8, so on a runner with no LANG the pane would paint `_` and the menu would not
    // parse. And `\xe2` is a bashism - `/bin/sh` is dash on Debian, which prints those
    // four characters verbatim - whereas `\342` is the escape POSIX printf specifies.
    const paint = 'printf "Which way should this go?\\n\\n\\342\\235\\257 1. Ship it\\n  2. Hold it\\n"';
    execFileSync("tmux", [
      "new-session", "-d", "-s", sessName, "-x", "120", "-y", "30",
      `sh -c '${paint}; while IFS= read -r l; do echo "$l" >> ${sink}; done'`,
    ]);
    const paneId = execFileSync("tmux", ["list-panes", "-t", sessName, "-F", "#{pane_id}"]).toString().trim();
    const session = { id: "real", agent: "claude", terminals: [tmux(paneId)] } as Session;

    // Baseline: the pane takes keystrokes, and the guard lets them through.
    assert.equal(await readTmuxPaneMode(paneId), null, "a fresh pane is in no mode");
    const before = await sendText(session, "BEFORE", true);
    assert.equal(before.ok, true, "a normal pane still accepts a write");

    execFileSync("tmux", ["copy-mode", "-t", paneId]);
    assert.equal(await readTmuxPaneMode(paneId), "copy-mode", "the probe sees the real mode");

    // The probe must survive a machine with no locale set. tmux sanitizes non-printable
    // bytes out of its own argv unless the client's LC_CTYPE is UTF-8, so a separator
    // like `\x1f` comes back as `_` and the answer parses as "not in a mode" - the guard
    // silently stops guarding. That is not a hypothetical environment: it is a launchd
    // daemon, and it is the CI runner this test file first went red on, where every
    // assertion above still passed because they all read the fail-open direction.
    assert.equal(await readTmuxPaneMode(paneId, noLocale), "copy-mode", "an unset LANG does not blind the probe");

    // The refusal - and, crucially, that the child is left untouched by it.
    const during = await sendText(session, "DURING", true);
    assert.equal(during.ok, false, "the write is refused rather than swallowed");
    assert.match(during.error ?? "", /copy-mode/);

    // The exact production shape: answering a menu row. Enter is the irreversible
    // keystroke, so this must refuse before pressing it.
    //
    // The menu has to be REAL, printed onto the pane before copy-mode was entered, or
    // this asserts nothing: `selectPaneOption` reads the dialog off the screen first and
    // refuses a pane with no menu on it, which is a refusal the guard plays no part in
    // and which passes identically with the guard deleted.
    const picked = await selectPaneOption(session, { number: 1, label: "Ship it" });
    assert.equal(picked.ok, false, "a menu is not 'answered' by an Enter tmux ate");
    assert.match(picked.error ?? "", /copy-mode/, "refused for the MODE, not for want of a menu");

    execFileSync("tmux", ["send-keys", "-X", "-t", paneId, "cancel"]);
    const after = await sendText(session, "AFTER", true);
    assert.equal(after.ok, true, "the refusal is transient - leaving the mode unblocks it");

    // Settle, then assert on what the CHILD received. This is the real claim: the
    // copy-mode write is absent, and it is absent without having corrupted the others.
    let got = "";
    for (let i = 0; i < 60; i++) {
      got = execFileSync("sh", ["-c", `cat ${sink} 2>/dev/null || true`]).toString();
      if (got.includes("AFTER")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(got.includes("BEFORE"), "the pre-copy-mode write reached the child");
    assert.ok(got.includes("AFTER"), "the post-cancel write reached the child");
    assert.ok(!got.includes("DURING"), "the copy-mode write reached NOTHING - which is why it must not report ok");
  } finally {
    try {
      execFileSync("tmux", ["kill-session", "-t", sessName], { stdio: "ignore" });
    } catch {
      /* the session may already be gone */
    }
    try {
      execFileSync("sh", ["-c", `rm -f /tmp/mc-copymode-${process.pid}.out`]);
    } catch {
      /* best effort */
    }
  }
});
