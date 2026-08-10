import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TerminalStatusLine,
  TerminalTitlebar,
  terminalLegend,
} from "../src/web/components/ConversationTerminal.tsx";
import type { TerminalAttach } from "../src/web/components/ConversationTerminal.tsx";
import type { Session } from "../src/shared/types.ts";
import { promptPath } from "../src/web/lib/format.ts";
import { meta, mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

/**
 * The terminal frame's chrome, which is where this rendering makes CLAIMS about a session
 * rather than drawing its transcript.
 *
 * The honesty contract from the observed-activity sideband applies here too, and it is
 * mostly a contract about absence: a status line is read at a glance, so a placeholder in
 * it is worse than a gap - `pid 0` reads as a real pid and a dash reads as "none" when the
 * truth is "we do not know". Every assertion below is either "this fact is drawn" or "this
 * fact is not invented".
 *
 * `renderToStaticMarkup` rather than a browser because the question is what the markup
 * says; that it reaches the screen at all is `e2e/specs/conversation-terminal-view.spec.ts`.
 */

function titlebar(over: Partial<Session> = {}, attach: TerminalAttach = "live"): string {
  return renderToStaticMarkup(
    createElement(TerminalTitlebar, { session: mkSession(over), attach }),
  );
}

function status(over: Partial<Session> = {}): string {
  return renderToStaticMarkup(createElement(TerminalStatusLine, { session: mkSession(over) }));
}

test("the titlebar names the window, the agent, and the shell it is really on", () => {
  const html = titlebar({ agent: "codex", tty: "ttys012" });
  assert.match(html, /mission-control: conversation/);
  assert.match(html, /codex/);
  assert.match(html, /ttys012/);
});

test("a session with no tty names its runtime rather than inventing a shell", () => {
  // The mockup's titlebar said `zsh`. An SDK session never had one, and printing a shell
  // name for a process that has no terminal is the kind of small lie this frame must not
  // tell - the reader would go looking for it.
  const html = titlebar({ runtime: "sdk", tty: null, terminals: [] });
  assert.match(html, /mission-control: conversation · claude · sdk/);
  assert.doesNotMatch(html, /zsh|bash|fish/);
});

test("the attach indicator follows the transcript stream, not the session's state", () => {
  // It answers "is the dashboard tailing this file right now", which is the one thing a
  // terminal's connection light should mean. A working session whose transcript could not
  // be resolved is detached, and says so.
  assert.match(titlebar({}, "live"), /attached/);
  assert.match(titlebar({}, "connecting"), /attaching/);
  const gone = titlebar({ state: "working" }, "unavailable");
  assert.match(gone, /detached/);
  assert.doesNotMatch(gone, /● attached/);
});

test("the status line carries the session's real run state, pid and branch", () => {
  const html = status({ state: "working", pid: 97533, gitBranch: "feat/persona-directives" });
  assert.match(html, /claude: working/);
  assert.match(html, /pid 97533/);
  assert.match(html, /feat\/persona-directives/);
});

test("the run state is the same reading the card badge shows", () => {
  // `stateDisplay` decides both, so a session parked on a review says "needs you" in the
  // status line for the same reason the card does. Two derivations would be two answers.
  assert.match(status({ state: "idle", pendingReviews: 1 }), /claude: to review/);
  assert.match(status({ state: "exited" }), /claude: exited/);
});

test("a session that reports no pid draws no pid, rather than pid 0", () => {
  // 0 is the wire contract's "no subprocess reported" - an SDK driver, most often - and
  // printing it would name a process that does not exist.
  const html = status({ pid: 0 });
  assert.doesNotMatch(html, /pid/);
});

test("a session off a checkout draws no branch, and one with no usage draws no context", () => {
  const bare = status({ gitBranch: null, meta: null });
  assert.doesNotMatch(bare, /⌁/);
  assert.doesNotMatch(bare, /ctx/);
  // And when the harness has reported usage, the share is drawn as the number it is.
  assert.match(status({ meta: meta({ contextPct: 48 }) }), /ctx 48%/);
});

test("the context share is absent while meta exists but has not learnt it yet", () => {
  assert.doesNotMatch(status({ meta: meta({ contextPct: null }) }), /ctx/);
});

test("the status line offers the chords, and no second button to kill a session with", () => {
  // Deliberate divergence from the mockup, which drew four buttons. Each of these actions
  // has exactly one control in this app; a second `kill` in a status bar would be a second
  // path to the most destructive thing here. The row teaches the chord instead.
  const html = status({ runtime: "sdk", terminals: [], task: mkTaskSummary() });
  assert.match(html, /terminal/);
  assert.match(html, /diff/);
  assert.match(html, /complete/);
  assert.match(html, /kill/);
  assert.doesNotMatch(html, /<button/, "the status line grew a button");
});

// ---- the legend teaches only chords that do something here ----
//
// A legend is a promise that a key works. The first slot is the one that bit: `handoff`
// (Shift+T, "Continue in terminal") returns immediately unless the session is SDK-driven,
// so on a pane-backed session - the ordinary tmux/wezterm shape - a hardcoded `handoff`
// entry taught a documented no-op while hiding `focus`, the chord that actually reaches
// that session's terminal. `ActionBar`'s footer has always switched the two; these pin that
// this row switches with it.

test("a pane-backed session is taught focus, not the SDK-only handoff", () => {
  const legend = terminalLegend(mkSession({ runtime: "terminal" }));
  assert.deepEqual(legend[0], { action: "focus", label: "focus" });
  assert.ok(
    !legend.some((e) => e.action === "handoff"),
    "a paned session was taught Shift+T, which its handler refuses",
  );
});

test("an SDK session is taught handoff, which is the one that works there", () => {
  const legend = terminalLegend(mkSession({ runtime: "sdk", terminals: [] }));
  assert.deepEqual(legend[0], { action: "handoff", label: "terminal" });
});

test("a session with no checkout is not taught diff, which the footer also omits", () => {
  const bare = terminalLegend(mkSession({ cwd: null })).map((e) => e.action);
  assert.ok(!bare.includes("diff"), "a session off a checkout was taught diff");
  // Kill still applies to any live session, and is what stops this from degrading to an
  // empty row that never says anything.
  assert.ok(bare.includes("kill"));

  const full = terminalLegend(mkSession({ cwd: "/wt/x", task: mkTaskSummary() })).map((e) => e.action);
  assert.deepEqual(full, ["focus", "diff", "complete", "kill"]);
});

test("a taskless session IS taught complete, because the chord still answers", () => {
  // The line the inclusion test is drawn on. `complete`'s button is drawn disabled without
  // a task, but `ActionBar.requestComplete` never checks for one - the chord opens
  // `CompleteModal` either way, and the modal is what says there is nothing to mark done
  // and to use Kill instead. Dropping the entry would hide a key that gives a real answer,
  // so "the action bar draws no control" is the test, not "its button is enabled".
  const actions = terminalLegend(mkSession({ task: null })).map((e) => e.action);
  assert.ok(actions.includes("complete"), "a taskless session was under-taught the complete chord");
});

test("a finished session is taught nothing, because it has no action bar either", () => {
  // Both hosts gate the whole action row on the session being live, so there is no button
  // for any of these on an exited card - and therefore nothing to teach.
  assert.deepEqual(terminalLegend(mkSession({ state: "exited" })), []);
  assert.deepEqual(terminalLegend(mkSession({ state: "stopping" })), []);
  // The rest of the line still reports: an exited session's state is exactly what a reader
  // has come to the status line for.
  assert.match(status({ state: "exited" }), /claude: exited/);
});

// ---- the prompt line's working directory ----
//
// One function owns the WHOLE displayed string, prefix included. It did not: the panel
// derived a leaf that fell back to "~", and the renderer prefixed every value with "~/",
// so a session with no checkout drew `you@mission ~/~ ❯ …`. Splitting a value between a
// producer and a template is what made that representable, and these pin the join.

test("a checkout draws as ~/leaf, not as the whole worktree path", () => {
  // The leaf, because this sits inline in a prompt line the reader scans for the words
  // after it - and the launcher strip above already prints the path in full.
  assert.equal(promptPath("/Users/j/.treehouse/pool-abc/20/ai-harness"), "~/ai-harness");
  assert.equal(promptPath("/wt/goal"), "~/goal");
  // A trailing slash is not an empty leaf.
  assert.equal(promptPath("/wt/goal/"), "~/goal");
});

test("a session with no checkout draws a bare ~, never ~/~", () => {
  assert.equal(promptPath(null), "~");
  assert.equal(promptPath(""), "~");
  // The pathological input that has no leaf at all takes the same branch, rather than
  // producing a prefix with nothing after it.
  assert.equal(promptPath("/"), "~");
});

test("an exited session's state is not dimmed by a rule written for whole cards", () => {
  // The status line borrows the `tone-*` family for its `--tone-color`, and that family
  // also carries an UNSCOPED `.tone-exited { opacity: .62 }` meant for a card, a rail row,
  // a board column - containers where dimming reads as "deprioritise me". Inherited by this
  // span it prints `claude: exited` at 62% while every other state stays full strength,
  // which is backwards: in a status line that word is the most important thing on the row.
  //
  // The markup half first - the span really does wear the tone class...
  assert.match(status({ state: "exited" }), /pty-live tone-exited/);
  // ...and the stylesheet half, which is the only place the inheritance can be answered.
  const css = readFileSync("src/web/styles.css", "utf8");
  assert.match(
    css,
    /\.tone-exited\s*\{[^}]*opacity/,
    "the container rule this guards against is gone - so is the need for the guard",
  );
  const scoped = /\.pty-status\s+\.pty-live\s*\{[^}]*opacity:\s*1/.exec(css);
  assert.ok(
    scoped,
    "the run state must restore its own opacity, scoped by two classes so it does not depend on rule order",
  );
});

test("the status line is addressable as the region it is", () => {
  // Selected by role and name in the browser test, which is the rule for every control
  // this app adds - never a test id.
  assert.match(status(), /aria-label="Session status"/);
});
