import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { ModePicker } from "../src/web/components/ModePicker.tsx";
import { RuntimeMetaRow } from "../src/web/components/session-bits.tsx";
import { GOAL_UNSUPPORTED } from "../src/shared/goal.ts";
import type { Session, SessionGoalSummary } from "../src/shared/types.ts";
import { meta, mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";
import { containsMarkup, hasTooltip } from "./helpers/markup.ts";

/**
 * The console detail's identity band: what it carries, and where.
 *
 * Two moves are pinned here, and both are the kind that a diff looks fine for and a reader
 * loses something to.
 *
 * The permission mode leads the runtime cluster - `mode · model · context · cost` - because
 * the posture governs the session while the other three are consequences of running under
 * it. It LEAVES the footer in the same move: a chip in both places would be the duplication
 * this band was tightened to remove.
 *
 * The objective joins the identity block under the title. `GoalLine` is moved rather than
 * re-implemented, and this file is the coverage that says so: the component carries a
 * `goal-{state}` class, a state-dependent tooltip and a `GOAL_UNSUPPORTED` empty state that
 * fires BEFORE its has-text guard, and a hand-rolled paragraph in the new location would
 * have dropped all three with nothing failing.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

function render(session: Session): string {
  return renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: mkSessionView(session) }),
  );
}

/** The header band, sliced off so "in the header" is a claim about position, not presence. */
function head(html: string): string {
  const start = html.indexOf('<header class="detail-head">');
  assert.ok(start >= 0, "the console detail should render its header band");
  return html.slice(start, html.indexOf("</header>"));
}

/** The footer band, likewise. */
function foot(html: string): string {
  const start = html.indexOf('<footer class="detail-foot">');
  assert.ok(start >= 0, "the console detail should render its footer band");
  return html.slice(start);
}

/**
 * The identity block, cut at its OWN closing tag rather than at the next landmark.
 *
 * Depth-counted, because "the objective is INSIDE `.detail-title`" is the entire claim
 * every assertion below rests on. Slicing to the header's spacer instead would swallow
 * `PrChip`, `InspectorChip`, `WorkflowChips`, `EnsembleChip`, the workflow-bind chip and
 * `StateBadge` along the way - and would go on passing with `GoalLine` rendered as
 * `.detail-title`'s SIBLING, which is the arrangement these tests exist to rule out.
 *
 * The first `</div>` is not the right one either: the block holds a nested
 * `.detail-title-line` for the name and its source. Counting depth is the cheapest honest
 * answer here, and it is safe against the markup React actually emits - there are no void
 * or self-closing `div`s, so opens and closes pair exactly.
 */
function titleBlock(html: string): string {
  const start = html.indexOf('<div class="detail-title">');
  assert.ok(start >= 0, "the console detail should render its identity block");
  const CLOSE = "</div>";
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith("<div", i)) depth += 1;
    else if (html.startsWith(CLOSE, i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + CLOSE.length);
    }
  }
  return assert.fail("`.detail-title` was opened and never closed");
}

const goal = (over: Partial<SessionGoalSummary> = {}): SessionGoalSummary => ({
  text: "Fix the flaky worktree cleanup on Reset",
  source: "model",
  updatedAt: 1000,
  ...over,
});

test("the permission mode chip leads the header cluster and has left the footer", () => {
  const session = mkSession({ permissionMode: "acceptEdits", meta: meta({ contextPct: 73 }) });
  const html = render(session);
  const chip = renderToStaticMarkup(createElement(ModePicker, { session }));

  assert.ok(containsMarkup(head(html), chip), "the header should carry the shared ModePicker");
  assert.ok(!containsMarkup(foot(html), chip), "the footer should no longer carry it");

  // Order, not just membership: the posture reads before the things it governs. Both are
  // in the header now, so their positions are comparable.
  const band = head(html);
  const runtime = renderToStaticMarkup(
    createElement(RuntimeMetaRow, { meta: session.meta!, session }),
  );
  assert.ok(
    band.indexOf(chip.slice(0, 40)) < band.indexOf(runtime.slice(0, 40)),
    "the mode chip should lead the model / context / cost cluster",
  );
});

test("a session with no runtime meta still gets its mode chip", () => {
  // `RuntimeMetaRow` returns null for a session with no model, thinking level or context,
  // so the chip is its sibling rather than its child - inside it, the posture would vanish
  // with the row for exactly the sessions that have told us least.
  const session = mkSession({ permissionMode: "plan", meta: null });
  const html = render(session);
  assert.ok(!html.includes("card-runtime"), "this fixture should draw no runtime row at all");
  assert.ok(
    containsMarkup(head(html), renderToStaticMarkup(createElement(ModePicker, { session }))),
    "the mode chip should survive without it",
  );
});

test("a harness with no permission modes draws no chip, and the header tolerates it", () => {
  // `ModePicker` answers this for every layout so none of them carries an agent check.
  const session = mkSession({ agent: "pi", permissionMode: null });
  assert.equal(renderToStaticMarkup(createElement(ModePicker, { session })), "");
  assert.ok(!render(session).includes('class="mode'), "no mode chip anywhere for pi");
});

test("the objective reads under the title, not in a band above the transcript", () => {
  const html = render(mkSession({ goal: goal() }));
  assert.match(
    titleBlock(html),
    /Fix the flaky worktree cleanup on Reset/,
    "the objective should sit in the identity block",
  );
  // One instance, not two: this is a relocation, not a second copy.
  assert.equal(html.match(/class="goal goal-model"/g)?.length, 1);
});

test("the relocated objective keeps every state class GoalLine draws", () => {
  // The signals a "move the text" reading would have dropped. Each is a different fact
  // about how much to trust the sentence, and each is carried by a class the CSS colours.
  const cases: [string, SessionGoalSummary][] = [
    ["goal-resolving", goal({ promptRevision: 2, resolvedPromptRevision: 1 })],
    ["goal-unclear", goal({ relationship: "unclear", promptRevision: 2, resolvedPromptRevision: 2 })],
    ["goal-heuristic", goal({ source: "heuristic" })],
  ];
  for (const [cls, g] of cases) {
    const block = titleBlock(render(mkSession({ goal: g })));
    assert.match(block, new RegExp(`class="goal ${cls}"`), `${cls} should reach the identity block`);
  }
});

test("the relocated objective keeps GoalLine's state-specific tooltip", () => {
  // Not the full text with a `title` attribute: the `unclear` variant states an operational
  // fact about Foreman that nothing else on this surface says.
  const html = render(
    mkSession({
      goal: goal({
        text: "Implement durable session objectives",
        relationship: "unclear",
        promptRevision: 2,
        resolvedPromptRevision: 2,
      }),
    }),
  );
  assert.ok(
    hasTooltip(
      html,
      "Implement durable session objectives (latest instruction may change this objective; automatic wrap-up is paused)",
    ),
    "the unclear variant's tooltip should survive the move",
  );
});

test("a harness that can never carry an objective still says so in the identity block", () => {
  // The case that fires with NO goal text, before `GoalLine`'s has-text guard. A relocation
  // gated on "has text" would leave these harnesses a blank gap where an honest sentence was.
  const why = "Test Harness sessions report no prompts.";
  const prior = GOAL_UNSUPPORTED.codex;
  GOAL_UNSUPPORTED.codex = why;
  try {
    const block = titleBlock(render(mkSession({ agent: "codex", goal: null })));
    assert.match(block, /class="goal goal-none"/);
    assert.match(block, /No goal/);
  } finally {
    GOAL_UNSUPPORTED.codex = prior;
  }
});

test("a session with no objective yet adds no empty line to the identity block", () => {
  assert.ok(!render(mkSession({ goal: null })).includes('class="goal'));
});

test("the transcript's leading children are one shorter, and .transcript stays a direct child", () => {
  // `.detail-conv > .pane-dialog` and `.detail-conv > .transcript` are child combinators in
  // shipped CSS and in `pane-dialog-scroll.test.ts`, so the objective had to leave without a
  // wrapper appearing in its place.
  const html = render(mkSession({ goal: goal(), activity: "running Bash" }));
  const conv = html.slice(html.indexOf('<div class="detail-conv">'));
  assert.match(conv, /^<div class="detail-conv"><p class="activity">running Bash<\/p>/);
});
