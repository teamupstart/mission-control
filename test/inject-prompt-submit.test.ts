import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { injectPrompt, type InjectDeps } from "../src/server/actions.ts";
import { bindSession } from "../src/server/terminal/registry.ts";
import { hasPendingCommand, hasPendingPaste } from "../src/server/discovery/pane-paste.ts";
import { HARNESSES } from "../src/server/harness/index.ts";
import { capturePaneText } from "../src/server/discovery/pane-capture.ts";
import type { Session } from "@shared/types.ts";
import type { TerminalHandle } from "@shared/terminal.ts";
import { stubRun } from "../src/server/util/exec.ts";
import { mkEmuHandle, mkMuxHandle } from "./helpers/session-fixture.ts";

// Delivering a prompt is a NON-ATOMIC sequence - buffer, paste, settle, read, Enter, read
// back - and the ORDER is the whole fix, so these tests assert the sequence rather than the
// outcome alone.
//
// The bug being pinned: Claude coalesces input for a window after a multi-line paste
// (the "paste again to expand" affordance), and an Enter inside that window is absorbed
// into the paste instead of submitting it. Paste and Enter used to be sent back-to-back,
// which put the Enter inside the window EVERY time - so every multi-line dispatch, which
// is every dispatch carrying an image path, pasted its prompt and then sat unsubmitted.
//
// Measured against Claude Code 2.1.215: swallowed at 0/50/100/200ms, submitted at
// 300/400/500ms. Single-line pastes are never collapsed and were never affected, which is
// why this read as intermittent rather than total.

/**
 * Claude's placeholder taken FROM its harness, not restated here. These cases are about
 * what the reader does with a placeholder; which regex Claude renders is the harness's
 * claim, and a copy of it here is a copy that can go on passing after the real one moves.
 */
const CLAUDE_PLACEHOLDER = (() => {
  const control = HARNESSES.claude.control;
  assert.equal(control.kind, "keystroke");
  const re = control.kind === "keystroke" ? control.pastePlaceholder : null;
  assert.ok(re, "Claude must declare a paste placeholder");
  return re;
})();

const PLACEHOLDER = "❯ [Pasted text #1 +3 lines]";
const EMPTY_COMPOSER = "❯\n⏵⏵ auto mode on (shift+tab to cycle)";

const tmuxSession = (paneId = "%1"): Session =>
  ({ id: "s1", agent: "claude", terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId })] }) as Session;

const weztermSession = (): Session =>
  ({ id: "s2", agent: "claude", terminals: [mkEmuHandle({ paneId: "7", tabId: "0", windowId: "0", tabTitle: "" })] }) as Session;

/** One entry per thing the delivery did, in order, so the sequence itself is assertable. */
type Event = { kind: "exec"; argv: string } | { kind: "sleep"; ms: number } | { kind: "capture" };

/**
 * A recording stand-in for the pane, which shows the collapsed paste until
 * `clearsAfterEnters` Enters have reached it.
 *
 * Stated in Enters rather than in captures on purpose: "the composer clears on the 2nd
 * Enter" is the actual claim under test, and it stays true regardless of how many times
 * the implementation reads the pane between them.
 */
function harness(clearsAfterEnters = 1): { deps: InjectDeps; events: Event[] } {
  const events: Event[] = [];
  let entersSeen = 0;
  return {
    events,
    deps: {
      // The real adapter on a fake subprocess, so the argv recorded here is the argv the
      // backend actually emits - which is what makes "pasted exactly once" a claim about
      // tmux commands rather than about a stand-in nobody ships.
      pane: (session) =>
        bindSession(session, async (bin, args) => {
          const argv = [bin, ...args].join(" ");
          events.push({ kind: "exec", argv });
          if (isEnter(argv)) entersSeen++;
          return stubRun({ stdout: "", stderr: "", code: 0 });
        }),
      capture: async () => {
        events.push({ kind: "capture" });
        return entersSeen >= clearsAfterEnters ? EMPTY_COMPOSER : PLACEHOLDER;
      },
      // Never actually waits: the waiting is asserted as an event, so the suite stays fast.
      sleep: async (ms) => {
        events.push({ kind: "sleep", ms });
      },
    },
  };
}

/**
 * Both handles submit with a keystroke of their own shape - a tmux key NAME, a wezterm
 * escape SEQUENCE - which is the whole reason the delivery path names a `Key` and lets the
 * adapter render it. The `--` in both is the adapters' flag terminator, so a prompt
 * beginning with a dash reaches the pane instead of the arg parser.
 */
const isEnter = (argv: string): boolean =>
  /send-keys .* -- Enter$/.test(argv) || argv.includes("--no-paste -- \r");

const argvs = (events: Event[]): string[] =>
  events.filter((e): e is Extract<Event, { kind: "exec" }> => e.kind === "exec").map((e) => e.argv);

const enters = (events: Event[]): number => argvs(events).filter(isEnter).length;
const pastes = (events: Event[]): number => argvs(events).filter((a) => a.includes("paste-buffer")).length;

// ---- the regression: the Enter must not land inside the coalescing window ----

test("the Enter waits for the paste to settle - it is never sent back-to-back with it", async () => {
  // THE BUG, pinned. Before the fix these two were adjacent and the Enter was swallowed.
  const { deps, events } = harness();
  const r = await injectPrompt(tmuxSession(), "line one\nline two\n\n/tmp/shot.png", deps);

  assert.equal(r.ok, true);
  const kinds = events.map((e) => (e.kind === "exec" ? e.argv : e.kind));
  const pasteAt = kinds.findIndex((k) => typeof k === "string" && k.includes("paste-buffer"));
  const sleepAt = kinds.findIndex((k) => k === "sleep");
  const enterAt = kinds.findIndex((k) => typeof k === "string" && /send-keys .* -- Enter$/.test(k));

  assert.ok(pasteAt >= 0 && sleepAt >= 0 && enterAt >= 0, "all three steps should have run");
  assert.ok(pasteAt < sleepAt, "the settle must come after the paste");
  assert.ok(sleepAt < enterAt, "the Enter must come after the settle, not adjacent to the paste");
  // A zero-length wait would satisfy the ordering above while restoring the exact
  // back-to-back timing that caused the bug, so the gap has to be a real one.
  const gap = events[sleepAt];
  assert.ok(gap?.kind === "sleep" && gap.ms > 0, "the settle must be an actual wait, not a no-op");
});

test("the settle is long enough to clear the measured coalescing window", async () => {
  // 200ms was still swallowed on 2.1.215; 300ms submitted. A settle at or under the
  // measured failure point would ship the bug back.
  const { deps, events } = harness();
  await injectPrompt(tmuxSession(), "a\nb", deps);
  const settle = events.find((e): e is Extract<Event, { kind: "sleep" }> => e.kind === "sleep");
  assert.ok(settle, "the delivery should settle before pressing Enter");
  assert.ok(settle.ms > 200, `settle of ${settle.ms}ms is inside the window that swallowed Enter`);
});

test("the delivery is verified against the pane, not assumed from tmux's exit code", async () => {
  // tmux reports that bytes were written, never what the TUI did with them - a pty
  // swallows an Enter as happily as it delivers one. The read-back is the only evidence.
  const { deps, events } = harness();
  await injectPrompt(tmuxSession(), "a\nb", deps);
  assert.ok(events.some((e) => e.kind === "capture"), "it must read the pane back");
});

test("the pane is read once BEFORE the Enter, while the paste is still definitively collapsed", async () => {
  // The other half of the sequence, and the half that makes verification a fact instead of
  // a race: after the Enter, the placeholder is gone whenever the TUI redraws before the
  // capture returns, so the reads that survive that are the ones where the Enter did NOT
  // land. Establishing "pending" here is the only reading that cannot be beaten by a
  // redraw. One read, not a poll - it is an observation, not a wait.
  const { deps, events } = harness();
  await injectPrompt(tmuxSession(), "a\nb", deps);
  const kinds = events.map((e) => (e.kind === "exec" ? e.argv : e.kind));
  const sleepAt = kinds.indexOf("sleep");
  const captureAt = kinds.indexOf("capture");
  const enterAt = kinds.findIndex((k) => typeof k === "string" && /send-keys .* -- Enter$/.test(k));

  assert.ok(captureAt > sleepAt, "the pre-Enter read must come after the settle");
  assert.ok(captureAt < enterAt, "it must come BEFORE the Enter, or it proves nothing");
  assert.equal(
    kinds.slice(0, enterAt).filter((k) => k === "capture").length,
    1,
    "exactly one read, spent on a state that has already happened",
  );
});

test("the ordinary success reports verified, and reports it the same way every run", async () => {
  // A healthy multi-line delivery - collapsed before the Enter, gone after it - is the
  // case the flag exists to distinguish from an unverifiable one, so it must not be the
  // case that comes back `false`, and it must not differ between two identical runs.
  for (let run = 0; run < 5; run++) {
    const { deps, events } = harness();
    const r = await injectPrompt(tmuxSession(), "a\nb", deps);
    assert.equal(r.ok, true);
    assert.equal(r.submitVerified, true, `run ${run} must not differ from the others`);
    assert.equal(enters(events), 1, `run ${run} must not differ from the others`);
  }
});

// ---- recovery: press Enter again, never paste again ----

test("a paste still in the composer gets another Enter - and never a second paste", async () => {
  // Re-pasting is what a caller would otherwise reach for, and it is destructive: a second
  // paste onto a collapsed placeholder EXPANDS it and appends a second copy, which is the
  // doubled, still-unsubmitted prompt this bug produced in the field.
  const { deps, events } = harness(2);
  const r = await injectPrompt(tmuxSession(), "a\nb", deps);

  assert.equal(r.ok, true, "the retried Enter should land");
  assert.ok(enters(events) >= 2, "a pending paste should be re-submitted");
  assert.equal(pastes(events), 1, "the text must be pasted EXACTLY once - Enter is the only retry");
});

test("it stops pressing Enter as soon as the composer clears", async () => {
  // Enter is idempotent into an empty composer but NOT into a dialog, so surplus keystrokes
  // are not free: one landing on a permission prompt answers it on the operator's behalf.
  const { deps, events } = harness();
  await injectPrompt(tmuxSession(), "a\nb", deps);
  assert.equal(enters(events), 1, "one Enter sufficed, so exactly one should have been sent");
});

test("a paste that outlasts every Enter fails loudly, and still reports the text as pasted", async () => {
  // `pasted: true` is what stops a caller re-delivering on top of it. The failure has to
  // carry that, or the recovery becomes the doubled prompt all over again.
  const { deps, events } = harness(Number.POSITIVE_INFINITY);
  const r = await injectPrompt(tmuxSession(), "a\nb", deps);

  assert.equal(r.ok, false, "a paste that never submitted is not a success");
  assert.equal(r.pasted, true, "the text IS in the pane - the caller must not re-deliver");
  assert.match(r.error ?? "", /unsubmitted|composer/i, "the error should say what is actually wrong");
  assert.equal(pastes(events), 1, "even giving up, it must never paste twice");
});

test("an unreadable pane ends the retry rather than spending a blind keystroke", async () => {
  // No capture means no evidence, and every Enter past the first is gated on evidence:
  // firing one at a pane we cannot see is the keystroke that answers an unread dialog.
  //
  // It also has to give up QUICKLY. The wait holds the pane lock for its whole duration,
  // and each capture carries a one-second timeout, so polling a dead pane to the end of
  // the window refuses every other write to that pane for longer than dispatch will wait
  // for its own accept.
  const events: Event[] = [];
  const deps: InjectDeps = {
    pane: (session) =>
      bindSession(session, async (bin, args) => {
        events.push({ kind: "exec", argv: [bin, ...args].join(" ") });
        return stubRun({ stdout: "", stderr: "", code: 0 });
      }),
    capture: async () => {
      events.push({ kind: "capture" });
      return null;
    },
    sleep: async () => {},
  };
  const r = await injectPrompt(tmuxSession(), "a\nb", deps);
  assert.equal(r.ok, true, "with nothing to see, the one Enter we sent stands");
  assert.equal(r.submitVerified, false, "a pane nobody could read verified nothing");
  assert.equal(enters(events), 1, "it must not keep firing at a pane it cannot read");
  const captures = events.filter((e) => e.kind === "capture").length;
  assert.ok(captures <= 4, `an unreadable pane cost ${captures} captures under the lock`);
});

// ---- the failure modes that must survive the rewrite ----

test("a paste that never left the buffer is still reported as retryable", async () => {
  // `pasted: false` is the ONLY state a caller may re-deliver from, so a failure before the
  // paste must keep saying so.
  const deps: InjectDeps = {
    pane: (session) =>
      bindSession(session, async (_bin, args) =>
        stubRun({ stdout: "", stderr: "no such pane", code: args.includes("paste-buffer") ? 1 : 0 }),
      ),
    capture: async () => EMPTY_COMPOSER,
    sleep: async () => {},
  };
  const r = await injectPrompt(tmuxSession(), "a\nb", deps);
  assert.equal(r.ok, false);
  assert.equal(r.pasted, false, "nothing reached the pane, so this is safe to retry");
});

test("wezterm settles before its Enter too", async () => {
  // The same TUI is on the other end of the wezterm handle, so it has the same window.
  const { deps, events } = harness();
  const r = await injectPrompt(weztermSession(), "a\nb", deps);
  assert.equal(r.ok, true);
  const kinds = events.map((e) => (e.kind === "exec" ? e.argv : e.kind));
  const sleepAt = kinds.indexOf("sleep");
  const enterAt = kinds.findIndex((k) => typeof k === "string" && k.includes("--no-paste -- \r"));
  assert.ok(sleepAt >= 0 && enterAt > sleepAt, "wezterm must settle before submitting");
});

test("a session with no pane is refused before any of this", async () => {
  const { deps } = harness();
  const r = await injectPrompt({ id: "s3", agent: "claude", terminals: [] as TerminalHandle[] } as Session, "a\nb", deps);
  assert.equal(r.ok, false);
  assert.equal(r.pasted, false);
});

// ---- reading the placeholder off a pane ----

test("the collapsed-paste placeholder is what marks a prompt as unsubmitted", () => {
  assert.equal(hasPendingPaste("❯ [Pasted text #1 +3 lines]\n⏵⏵ auto mode on", CLAUDE_PLACEHOLDER), true);
  // The index climbs as pastes accumulate within a turn, so it cannot be pinned to #1.
  assert.equal(hasPendingPaste("❯ [Pasted text #4 +12 lines]\n⏵⏵ auto mode on", CLAUDE_PLACEHOLDER), true);
  assert.equal(hasPendingPaste("❯ prose the human typed\n⏵⏵ auto mode on", CLAUDE_PLACEHOLDER), false);
  assert.equal(hasPendingPaste(EMPTY_COMPOSER, CLAUDE_PLACEHOLDER), false);
});

test("a placeholder scrolled up into the transcript is not a pending paste", () => {
  // Only the composer counts. A submitted paste stays visible in the transcript above,
  // and reading that as pending would fire Enter at a session already working.
  const transcript = `❯ [Pasted text #1 +3 lines]\n${Array.from({ length: 20 }, (_, i) => `output line ${i}`).join("\n")}\n❯\n⏵⏵ auto mode on`;
  assert.equal(hasPendingPaste(transcript, CLAUDE_PLACEHOLDER), false);
});

test("nothing on screen is not evidence of a pending paste", () => {
  // This gates a keystroke, so the unknown case must read as "no".
  assert.equal(hasPendingPaste(null, CLAUDE_PLACEHOLDER), false);
  assert.equal(hasPendingPaste("", CLAUDE_PLACEHOLDER), false);
});

test("a slash command still in the composer is what marks a /clear as unacted on", () => {
  // The caller is a reset that sends `/clear` and then wants to paste a task behind it.
  // A `/clear` the agent has not processed yet wipes that paste when it finally lands,
  // and every check downstream still reads success - so the composer is read first.
  assert.equal(hasPendingCommand("❯ /clear\n⏵⏵ auto mode on", "/clear"), true);
  assert.equal(hasPendingCommand(EMPTY_COMPOSER, "/clear"), false);
  // The command ECHOED up in the transcript is history, not a keystroke in flight -
  // counting it would mean the wait could never end.
  const transcript = `❯ /clear\n${Array.from({ length: 20 }, (_, i) => `output line ${i}`).join("\n")}\n❯\n⏵⏵ auto mode on`;
  assert.equal(hasPendingCommand(transcript, "/clear"), false);
  assert.equal(hasPendingCommand(null, "/clear"), false);
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

test("the placeholder is detected through a real capture-pane", { skip: tmuxAvailable() ? false : "tmux not available" }, async () => {
  // The parser above works on strings a test wrote. This proves the same detection holds on
  // bytes that actually round-tripped through a terminal - the composer line rendered into
  // a live pane and read back out by the real `capturePaneText`.
  const sessName = `mc-paste-${process.pid}`;
  const tmux = (paneId: string) => mkMuxHandle({ session: sessName, windowName: "0", paneId });
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sessName, "-x", "200", "-y", "50"]);
    execFileSync("tmux", ["send-keys", "-t", sessName, "-l", 'clear; printf "\\n> [Pasted text #1 +3 lines]\\n"; read x']);
    execFileSync("tmux", ["send-keys", "-t", sessName, "Enter"]);
    const paneId = execFileSync("tmux", ["list-panes", "-t", sessName, "-F", "#{pane_id}"]).toString().trim();
    const session = { id: "real", agent: "claude", terminals: [tmux(paneId)] } as Session;

    // Wait for the pane to RENDER the line, which is TWO conditions and needs both. The
    // shell's echo of the command has to be gone (it contains the placeholder as literal
    // argument text, so detecting it would prove nothing), AND the printf's own output has
    // to have arrived. Breaking on the first alone raced: `clear` wipes the echo one redraw
    // BEFORE the output lands, so a loaded machine reads an empty screen and calls it
    // rendered. The wait is for the raw line, never for the predicate under test.
    let text: string | null = null;
    for (let i = 0; i < 60; i++) {
      text = await capturePaneText(session);
      if (text && !text.includes("printf") && text.includes("[Pasted text #1")) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(text, "the pane should have been capturable");
    assert.equal(hasPendingPaste(text, CLAUDE_PLACEHOLDER), true, "a real rendered placeholder should read as pending");
  } finally {
    try {
      execFileSync("tmux", ["kill-session", "-t", sessName], { stdio: "ignore" });
    } catch {
      /* the session may already be gone */
    }
  }
});
