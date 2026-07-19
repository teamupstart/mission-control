import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { injectPrompt, selectPaneOption, sendText, type InjectDeps } from "../src/server/actions.ts";
import { readTmuxPaneMode } from "../src/server/discovery/tmux.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import type { Session, TmuxInfo } from "@shared/types.ts";

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
  ({ id: "s1", agent: "claude", tmux: { session: "s", window: "w", windowIndex: 0, paneId }, wezterm: null }) as Session;

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0 });

/** Answer the mode probe with `inMode`, and record everything else that was attempted. */
function harness(inMode: string, mode = "copy-mode"): { deps: InjectDeps; argv: string[] } {
  const argv: string[] = [];
  return {
    argv,
    deps: {
      exec: async (bin, args) => {
        const line = [bin, ...args].join(" ");
        if (args.includes("display-message")) return ok(`${inMode}\x1f${mode}`);
        argv.push(line);
        return ok("");
      },
      capture: async () => "",
      sleep: async () => {},
    },
  };
}

// ---- the probe ----

test("the probe reads a mode only from an explicit in-mode flag", async () => {
  const probe = (out: string, code = 0) =>
    readTmuxPaneMode("%1", async () => ({ stdout: out, stderr: "", code }));

  assert.equal(await probe("1\x1fcopy-mode"), "copy-mode");
  assert.equal(await probe("1\x1fview-mode"), "view-mode");
  assert.equal(await probe("0\x1f"), null, "a pane in no mode takes keystrokes normally");
});

test("a probe that cannot answer reads as 'not in a mode', not as 'blocked'", async () => {
  // Deliberately fail-open, and the one place in this fix that does. A tmux too old to
  // know these formats, a dead pane, or no server at all would otherwise refuse EVERY
  // write on the machine - a total outage, traded for the single swallowed keystroke this
  // guard exists to catch. Absence of evidence is not evidence of copy-mode.
  const probe = (out: string, code = 0) =>
    readTmuxPaneMode("%1", async () => ({ stdout: out, stderr: "", code }));

  assert.equal(await probe("", 1), null, "no such pane / no tmux server");
  assert.equal(await probe(""), null, "empty output");
  assert.equal(await probe("#{pane_in_mode}"), null, "a tmux that left the format unexpanded");
});

test("a pane in a mode tmux won't name is still refused", async () => {
  // `pane_mode` predates neither flag on every tmux; an empty name must not read as "free".
  const mode = await readTmuxPaneMode("%1", async () => ok("1\x1f"));
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

test("a real pane in copy-mode swallows keystrokes that tmux reports as sent", { skip }, async () => {
  // The whole fix rests on a claim about tmux's behavior, not about our code: that
  // `send-keys` exits 0 while the child gets nothing. If that were ever false the guard
  // would be pointless, so it is asserted against a real tmux rather than assumed.
  const sessName = `mc-copymode-${process.pid}`;
  const tmux = (paneId: string): TmuxInfo => ({ session: sessName, window: "0", windowIndex: 0, paneId });
  try {
    // A pane that appends every line it receives, so "did the child see it" is a fact on
    // disk rather than an inference from the screen.
    const sink = `/tmp/${sessName}.out`;
    execFileSync("tmux", [
      "new-session", "-d", "-s", sessName, "-x", "120", "-y", "30",
      `sh -c 'while IFS= read -r l; do echo "$l" >> ${sink}; done'`,
    ]);
    const paneId = execFileSync("tmux", ["list-panes", "-t", sessName, "-F", "#{pane_id}"]).toString().trim();
    const session = { id: "real", agent: "claude", tmux: tmux(paneId), wezterm: null } as Session;

    // Baseline: the pane takes keystrokes, and the guard lets them through.
    assert.equal(await readTmuxPaneMode(paneId), null, "a fresh pane is in no mode");
    const before = await sendText(session, "BEFORE", true);
    assert.equal(before.ok, true, "a normal pane still accepts a write");

    execFileSync("tmux", ["copy-mode", "-t", paneId]);
    assert.equal(await readTmuxPaneMode(paneId), "copy-mode", "the probe sees the real mode");

    // The refusal - and, crucially, that the child is left untouched by it.
    const during = await sendText(session, "DURING", true);
    assert.equal(during.ok, false, "the write is refused rather than swallowed");
    assert.match(during.error ?? "", /copy-mode/);

    // The exact production shape: answering a menu row. Enter is the irreversible
    // keystroke, so this must refuse before pressing it.
    const picked = await selectPaneOption(session, { number: 1, label: "anything" });
    assert.equal(picked.ok, false, "a menu is not 'answered' by an Enter tmux ate");

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
