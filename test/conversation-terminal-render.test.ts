import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TerminalStatusLine,
  TerminalTitlebar,
} from "../src/web/components/ConversationTerminal.tsx";
import type { TerminalAttach } from "../src/web/components/ConversationTerminal.tsx";
import type { Session } from "../src/shared/types.ts";
import { meta, mkSession } from "./helpers/session-fixture.ts";

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
  const html = status();
  assert.match(html, /terminal/);
  assert.match(html, /diff/);
  assert.match(html, /complete/);
  assert.match(html, /kill/);
  assert.doesNotMatch(html, /<button/, "the status line grew a button");
});

test("the status line is addressable as the region it is", () => {
  // Selected by role and name in the browser test, which is the rule for every control
  // this app adds - never a test id.
  assert.match(status(), /aria-label="Session status"/);
});
