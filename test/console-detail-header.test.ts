import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { ModePicker } from "../src/web/components/ModePicker.tsx";
import { RuntimeMetaRow } from "../src/web/components/session-bits.tsx";
import { GOAL_UNSUPPORTED } from "../src/shared/goal.ts";
import type { Session, SessionGoalSummary } from "../src/shared/types.ts";
import { meta, mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";
import { updateUiConfig } from "../src/web/lib/uiConfig.ts";
import { UI_CONFIG_DEFAULTS } from "../src/shared/protocol.ts";
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

test("the conversation has no leading status band, and .transcript stays a direct child", () => {
  // Both halves of D4 have now left this container - the objective for `.detail-title`
  // (above) and the activity line for the tail of the log (`transcript-in-progress-row`) -
  // so with nothing to answer first the transcript is the FIRST thing under the tab row.
  //
  // `.detail-conv > .pane-dialog` and `.detail-conv > .transcript` are child combinators in
  // shipped CSS and in `pane-dialog-scroll.test.ts`, so neither could leave by being wrapped.
  const html = render(mkSession({ goal: goal(), activity: "running Bash", state: "working" }));
  const conv = html.slice(html.indexOf('<div class="detail-conv">'));
  assert.match(conv, /^<div class="detail-conv"><div class="transcript"/);
});

/**
 * The `PATH`/`BRANCH` band, and the container that stops drawing when it is empty.
 *
 * Two facts and a preference each, plus the rule that makes the height real: the band also
 * hosts a task's chip and its pull requests, so hiding both cells collapses it only when
 * nothing else is in it. Both halves are pinned below, and the second is what stops the
 * guard from degenerating into "hide the band whenever the cells are hidden" - which would
 * take a scout task's kind, a re-assigned session's title, an outcome link and a multi-repo
 * task's pull requests off screen with them.
 *
 * `updateUiConfig` is how the hidden list is set, rather than a prop: the registry is read
 * through `useUiConfig`, which is a `useSyncExternalStore` whose server snapshot is its
 * client snapshot, so a static render sees whatever the module store currently holds. The
 * fetch below is why a set STICKS - `updateUiConfig` takes its optimistic commit back when
 * the daemon refuses, and there is no daemon here.
 */
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
});

/** The band, or null when the component drew none at all. */
function band(html: string): string | null {
  const start = html.indexOf('<dl class="detail-sub">');
  if (start < 0) return null;
  return html.slice(start, html.indexOf("</dl>", start));
}

/** Render a session with a chosen hidden list in force, restoring the shipped default after. */
async function renderHiding(
  hidden: readonly string[],
  session: Session,
): Promise<string> {
  await updateUiConfig({ hiddenDisplayItems: [...hidden] });
  try {
    return render(session);
  } finally {
    await updateUiConfig({
      hiddenDisplayItems: [...UI_CONFIG_DEFAULTS.hiddenDisplayItems],
    });
  }
}

const BOTH_OFF = ["detailPath", "detailBranch"];

/** A dispatched session whose task pill is silent - the ordinary case F4 describes. */
function silentTaskSession(over: Partial<Session> = {}): Session {
  const title = "Fix the parser";
  return mkSession({
    name: title,
    task: mkTaskSummary({ title, fullTitle: title, kind: "ship" }),
    ...over,
  });
}

test("both cells ship visible, so an upgrade moves nothing", async () => {
  // D2. Not "the defaults are `[]`" - the claim is about what a reader sees, which is the
  // only form of it the three e2e specs reading `.detail-sub` care about.
  const html = render(mkSession());
  const sub = band(html);
  assert.ok(sub, "the band should draw for a session with a path and a branch");
  assert.match(sub, /<dt>path<\/dt>/);
  assert.match(sub, /<dt>branch<\/dt>/);
  assert.ok(sub.includes("/wt/app-bugfixes".slice(-12)), "the path cell lost its value");
  assert.ok(sub.includes("harness/app-bugfixes"), "the branch cell lost its value");
});

test("hiding the path removes the cell and leaves the branch alone", async () => {
  const sub = band(await renderHiding(["detailPath"], mkSession()));
  assert.ok(sub, "hiding one cell should not collapse the band");
  assert.ok(!sub.includes("<dt>path</dt>"), "the path cell is still drawn");
  assert.match(sub, /<dt>branch<\/dt>/);
});

test("hiding the branch removes the cell and leaves the path alone", async () => {
  const sub = band(await renderHiding(["detailBranch"], mkSession()));
  assert.ok(sub, "hiding one cell should not collapse the band");
  assert.match(sub, /<dt>path<\/dt>/);
  assert.ok(!sub.includes("<dt>branch</dt>"), "the branch cell is still drawn");
});

test("the path keeps its untruncated tooltip, which is the only place the full path is readable", () => {
  // Guarded here because the cell moved inside a conditional, and a Tooltip left behind in
  // that move would fail nothing else in this file.
  const html = render(mkSession());
  assert.ok(hasTooltip(html, "/wt/app-bugfixes"), "the path cell lost its full-path tooltip");
});

test("with both cells off and nothing else in it, the band does not render at all", async () => {
  // The height, at its narrowest: not an empty `<dl>` with its padding and its border, which
  // would be a bar of chrome saying nothing. The element is absent.
  const html = await renderHiding(BOTH_OFF, silentTaskSession());
  assert.equal(band(html), null, "an empty band is still drawn");
  assert.ok(!html.includes("detail-sub"), "the band's class survives somewhere");
});

test("a session with no task at all collapses the band too", async () => {
  const html = await renderHiding(BOTH_OFF, mkSession({ task: null }));
  assert.equal(band(html), null, "an empty band is still drawn");
});

test("a session with no branch keeps its band for the path alone", async () => {
  // The branch cell's own condition survives the preference: the gate is additional, not a
  // replacement, so a branchless session is unchanged by having `detailBranch` on.
  const sub = band(render(mkSession({ gitBranch: null })));
  assert.ok(sub, "the band should still draw for the path");
  assert.ok(!sub.includes("<dt>branch</dt>"));
});

test("a speaking task chip keeps the band even with both cells hidden", async () => {
  // F4's other half, and the reason the guard asks the container rather than the cells. A
  // scout task's kind is the only place that fact appears in the console.
  const html = await renderHiding(
    BOTH_OFF,
    silentTaskSession({ task: mkTaskSummary({ kind: "scout", title: "Fix the parser" }) }),
  );
  const sub = band(html);
  assert.ok(sub, "the band collapsed and took the task chip with it");
  assert.match(sub, /class="task-kind"/);
});

test("a task's pull requests keep the band even with both cells hidden", async () => {
  const html = await renderHiding(
    BOTH_OFF,
    silentTaskSession({
      task: mkTaskSummary({
        title: "Fix the parser",
        repoPrs: [
          {
            repoRoot: "/repos/app",
            primary: true,
            prUrl: "https://github.com/o/app/pull/7",
            prState: "open",
            mergedAt: null,
            feedback: null,
          },
        ],
      }),
    }),
  );
  const sub = band(html);
  assert.ok(sub, "the band collapsed and took the repo pull requests with it");
  assert.match(sub, /class="task-repo-prs"/);
});

test("the collapsed band leaves nothing behind in its place", async () => {
  // Nothing structural hung off `.detail-sub`: both neighbours own their own bottom rule, so
  // its absence must leave no spacer, no empty wrapper and no compensating element. Stated
  // as "what follows the header is what used to follow the band", which is the same claim
  // without naming whichever element that happens to be.
  const session = silentTaskSession();
  const withBand = render(session);
  const afterBand = withBand.slice(withBand.indexOf("</dl>") + "</dl>".length);
  const collapsed = await renderHiding(BOTH_OFF, session);
  const afterHead = collapsed.slice(collapsed.indexOf("</header>") + "</header>".length);
  assert.equal(afterHead, afterBand);
});
