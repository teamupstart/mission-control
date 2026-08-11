import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingTurn, Session, TranscriptMessage } from "../src/shared/types.ts";
import { liveActivity } from "../src/shared/session.ts";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { resetSessionViews, writeSessionView } from "../src/web/lib/conversation-view.ts";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import { hasTooltipStarting } from "./helpers/markup.ts";

/**
 * The turn currently arriving, at the tail of the log.
 *
 * `session.activity` used to be a fixed band above the transcript, which made a line about
 * the present into chrome: it was drawn at the top of a pane whose present is at the
 * bottom, and it cost the conversation its height whether or not anything was running. It
 * now renders as the log's last row, where the next real turn replaces it.
 *
 * What this file pins is WHEN it is drawn and WHERE, because both are easy to get subtly
 * wrong and neither shows up as a crash:
 *
 * - `activity` is written on every lifecycle event, not only the busy ones, so a settled
 *   session's copy of it is a status label the state badge already carries. A row that
 *   ignored that would leave "idle" spinning at the bottom of a log forever.
 *   `liveActivity` is the shared gate, and the board tile asks it the same question.
 * - It is drawn BEFORE `session.pendingTurns`, which are the human's undelivered messages.
 *   The other order reads as though the queue had already been answered.
 * - It is not the "Observed activity" rail beside the log. That rail lists calls the
 *   transcript recorded and is forbidden from claiming any of them is running; this row
 *   claims exactly that, about one step, from the session rather than from the log. Both
 *   render in the same panel, so "two different things" has to be checkable here.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const ACTIVITY = "running Bash";

function messages(): TranscriptMessage[] {
  return [
    { id: "m0", role: "user", text: "Reproduce the flake first.", tools: [], ts: 1 },
    { id: "m1", role: "assistant", text: "On it - starting with the worktree pool.", tools: [], ts: 2 },
  ];
}

function queued(): PendingTurn {
  return {
    id: "pending-1",
    noteKey: "agent-1",
    seq: 0,
    text: "And check the reaper while you are in there.",
    state: "queued",
    revision: 0,
    createdAt: 3,
    updatedAt: 3,
    claimedAt: null,
    lastError: null,
  };
}

/** The real panel, hydrated with a real conversation through the history map. */
function render(over: Partial<Session> = {}): string {
  resetHistories();
  seedTail("s1", { messages: messages(), start: 0, atStart: true, pos: 1000 });
  return renderToStaticMarkup(
    createElement(TranscriptPanel, {
      session: mkSession({ id: "s1", state: "working", activity: ACTIVITY, ...over }),
      canSend: true,
    }),
  );
}

test("a working session's current step reads at the tail of the log", () => {
  const html = render();
  assert.match(html, /<p class="turn-progress"/, "the row should render");
  assert.match(html, /class="turn-progress-text">running Bash</);
  // Whose step it is. The byline is the same speaker the assistant turns above carry, drawn
  // through the log's own `.turn-role` so the row reads in the same rhythm as them.
  assert.match(html, /class="turn-role turn-progress-who">claude</);
});

test("the terminal drawing gets the row as an entry in its stream", () => {
  // The two renderings of this log lay out differently: the terminal has no flex gap, a
  // 24px inset and a spine with a node per entry. Found in a browser rather than in the
  // diff - the row was sitting flush against the last entry and two dozen pixels left of
  // everything else. It takes `.pty-entry` there rather than restating those rules, which
  // is also what puts the spine's `:last-child` stop on the row that is actually last.
  writeSessionView("s1", "terminal");
  try {
    assert.match(render(), /class="turn-progress pty-entry"/);
  } finally {
    resetSessionViews();
  }
  // And the chat drawing does NOT, which is what makes the class a rendering choice rather
  // than something the row carries everywhere.
  assert.match(render(), /class="turn-progress"/);
});

test("the row says what it is, so it is never read as a recorded turn", () => {
  // The wording matters more here than in most places: the row sits inches from a rail
  // called "Observed activity" that means something else, and one line of muted text
  // cannot carry that distinction on its own.
  assert.ok(
    hasTooltipStarting(render(), "What claude reports it is doing right now: running Bash."),
    "the in-progress row should describe itself as a live report rather than a turn",
  );
});

test("it is drawn before the human's queued messages, not after them", () => {
  const html = render({ pendingTurns: [queued()] });
  const progress = html.indexOf('class="turn-progress"');
  const pending = html.indexOf("pending-turn is-queued");
  const lastTurn = html.indexOf("starting with the worktree pool");
  assert.ok(progress > lastTurn, "the row belongs after the turns the transcript recorded");
  assert.ok(
    progress < pending,
    "a queued message has not been delivered yet, so the step running now precedes it",
  );
});

test("a settled session shows no row, whatever its activity field still holds", () => {
  // The case that makes the gate worth having: `activity` is not cleared when a session
  // goes idle, it is OVERWRITTEN with a status word. Rendering it unconditionally would
  // leave a spinner on the word "idle".
  for (const state of ["idle", "awaiting_input", "awaiting_review", "stopping", "exited"] as const) {
    const html = render({ state, activity: "idle" });
    assert.doesNotMatch(html, /turn-progress/, `a ${state} session should draw no in-progress row`);
  }
});

test("a live session with nothing reported shows no row", () => {
  assert.doesNotMatch(render({ activity: null }), /turn-progress/);
});

test("a session whose push channel has lapsed shows no row", () => {
  // `instrumented` false means the hook overlay is stale: the passive poller refreshes
  // `state` from the transcript and leaves `activity` at whatever it last saw, so the
  // line would be a claim about the present sourced from an hour ago.
  assert.doesNotMatch(render({ instrumented: false }), /turn-progress/);
});

test("`liveActivity` is the one gate, and both surfaces ask it", () => {
  const live = mkSession({ state: "working", activity: ACTIVITY });
  assert.equal(liveActivity(live), ACTIVITY);
  assert.equal(liveActivity({ ...live, state: "starting" }), ACTIVITY);
  assert.equal(liveActivity({ ...live, state: "idle" }), null);
  assert.equal(liveActivity({ ...live, instrumented: false }), null);
  assert.equal(liveActivity({ ...live, activity: null }), null);
});

test("the in-progress row and the Observed activity rail are different things", () => {
  // Both are in this markup. The rail is derived from `messages` and says so on its face;
  // the row is the session's live report. A future change that folded one into the other
  // would have to delete one of these two assertions to pass.
  const html = render();
  assert.match(html, /Tool calls observed in the loaded transcript\./);
  assert.match(html, /<p class="turn-progress"/);
  // And the row is not inside the rail: it is a child of the log, which is what puts it at
  // the tail of the conversation rather than in the column beside it.
  const log = html.slice(html.indexOf('<div class="transcript-log"'));
  const rail = log.indexOf('<section class="activity-rail"');
  assert.ok(rail >= 0, "the rail should render beside the log");
  assert.ok(log.indexOf('class="turn-progress"') < rail, "the row belongs to the log, not the rail");
});

test("the row cannot wrap, because wrapping would break the log's stick-to-bottom", () => {
  // `onScroll` calls the reader "at the bottom" within 48px of it. A row free to grow to
  // three lines appears underneath a bottom-pinned reader, pushes them past that
  // threshold, and the pane silently stops following the conversation. One line can never
  // spend that budget, so the clip is a correctness requirement and is pinned as one.
  const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  const block = css.slice(css.indexOf(".turn-progress {"));
  const rule = block.slice(0, block.indexOf("}"));
  assert.match(rule, /white-space:\s*nowrap/, ".turn-progress must be held to a single line");
  const text = css.slice(css.indexOf(".turn-progress-text {"));
  assert.match(text.slice(0, text.indexOf("}")), /text-overflow:\s*ellipsis/);
});

/**
 * The dependency SET of the hook whose body contains `bodyLine`, sorted.
 *
 * Parsed rather than matched, on the model of `dropdown-consistency.test.ts`: what the
 * assertion below is about is which values the effect re-runs on, and that is a set. Which
 * order they are written in, whether the array wraps across lines, and whether the last one
 * carries a trailing comma are formatting, and a test that failed on any of those would be
 * failing for a reason nobody changed the behaviour with.
 */
function hookDeps(source: string, bodyLine: string): string[] {
  const at = source.indexOf(bodyLine);
  assert.ok(at >= 0, `no hook body in TranscriptPanel.tsx containing: ${bodyLine}`);
  const closing = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(source.slice(at));
  assert.ok(closing, "the hook should close with a dependency array");
  return closing[1]!
    .split(",")
    .map((dep) => dep.trim())
    .filter(Boolean)
    .sort();
}

test("the tail-following effect declares the in-progress row among its dependencies", () => {
  // F4, defect one. The layout effect that re-pins the log runs on its dependencies and
  // nothing else, so a row that changes the log's height while absent from that set leaves
  // a bottom-pinned reader a row short of the bottom, silently.
  //
  // This is a wiring assertion and says so, because the behaviour it defends is not
  // reachable from this layer: `renderToStaticMarkup` runs no effects and produces no
  // scroll container, and AGENTS.md rules out jsdom without a project decision.
  // `e2e/specs/conversation-in-progress-row.spec.ts` is where the behaviour is measured, in
  // a real scroll container, and it is mutation-tested.
  //
  // Both are needed because the entry is currently REDUNDANT. An activity change can only
  // arrive as a whole-session upsert, and every one of those re-parses
  // `session.pendingTurns` into a fresh array, so the neighbouring dependency already
  // re-runs the effect on the same tick - which is why the browser spec stays green with
  // `inProgress` removed and goes red only when the masking goes too. Listing it is what
  // keeps the effect standing on its own values instead of on an accident of the transport,
  // and this is the assertion that notices if it stops.
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/components/TranscriptPanel.tsx", import.meta.url)),
    "utf8",
  );
  assert.deepEqual(
    hookDeps(source, "if (atBottom.current) el.scrollTop = el.scrollHeight;"),
    ["inProgress", "messages", "session.pendingTurns"],
    "the tail-following effect must re-run when the in-progress row changes the log's height",
  );
});
