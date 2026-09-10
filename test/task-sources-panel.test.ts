import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SourceCard,
  TaskSourcesPanel,
  WritebackFields,
} from "../src/web/components/TaskSourcesPanel.tsx";
import type {
  TaskSourceInstance,
  TaskSourceWritebackStatus,
  TaskSourcesView,
} from "../src/shared/task-source.ts";
import type { TaskSourcesState } from "../src/web/useTaskSources.ts";

// What is at stake: this panel is where an operator decides to let something create work
// on their behalf, so it has to be honest about two things a control cannot say by itself.
//
//  - What a source actually DOES. It files backlog rows and nothing else - it never
//    dispatches an agent, cuts a worktree or types into a session. Turning one on is a
//    far smaller decision than the Inspector or Shipping, and the panel is the only place
//    that can say so.
//  - Which of "off", "never swept" and "swept, found nothing" it is looking at. Those
//    three render identically if nobody insists otherwise, and reading the first two as
//    the third is how a source broken since setup goes unnoticed for a week.
//
// Rendered rather than driven through a browser, for the reason every other settings test
// is: the dashboard's SSE stream holds the connection open and hangs headless automation.
// Static markup runs no effects, so nothing fetches and the pre-poll state is what draws -
// which is also the state a first-run user sees.

// Both kinds this build offers, as the daemon reports them. The panel derives its add
// control and its type filter from this list rather than a hand-kept one, so a kind missing
// here is a kind an operator cannot reach.
const KINDS = [
  { kind: "github-issues" as const, label: "GitHub issues", blurb: "Files an open issue." },
  { kind: "jira" as const, label: "Jira", blurb: "Files the issues a JQL filter matches." },
];

function mkSource(over: Partial<TaskSourceInstance> = {}): TaskSourceInstance {
  return {
    id: "src-1",
    kind: "github-issues",
    label: "widgets bugs",
    enabled: false,
    repoRoot: "/repo/widgets",
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: true },
    maxPerSweep: 25,
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
    config: {},
    ...over,
  } as TaskSourceInstance;
}

function mkState(view: TaskSourcesView | null): TaskSourcesState {
  return {
    view,
    save: async () => true,
    sweep: async () => null,
    preflight: async () => null,
    forget: async () => {},
    retryWriteback: async () => 0,
    discardWriteback: async () => 0,
    error: null,
  };
}

function render(view: TaskSourcesView | null): string {
  return renderToStaticMarkup(createElement(TaskSourcesPanel, { state: mkState(view) }));
}

const viewOf = (
  sources: TaskSourceInstance[],
  status: TaskSourcesView["status"] = [],
  writeback: TaskSourcesView["writeback"] = [],
) => ({ sources, status, writeback, kinds: KINDS });

// The claim the whole feature rests on, and the one an operator cannot verify from the
// controls. If this sentence ever goes, the panel is asking for consent to something it
// has stopped describing.
test("the panel says a source never dispatches, provisions or types", () => {
  const html = render(viewOf([]));
  assert.match(html, /never dispatches an agent/);
  assert.match(html, /never cuts a worktree/);
  assert.match(html, /never types into a session/);
});

// The other half of the bargain: a task you delete stays deleted, which is what makes the
// backlog a list you can say no to rather than one that refills behind you.
test("the panel says a deleted task stays deleted", () => {
  assert.match(render(viewOf([])), /a task you\s*delete stays deleted/);
});

// A static render is the pre-poll state. Drawing an empty list there tells an operator
// that nothing is being swept, while the stored config may be sweeping four things.
test("with no answer from the daemon, the panel says so rather than drawing an empty list", () => {
  const html = render(null);
  assert.match(html, /ts-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(html, /No sources yet/, "an unanswered panel must not assert emptiness");
});

// The answered-and-genuinely-empty case, which is a different sentence.
test("an answered, empty config says nothing is being swept", () => {
  const html = render(viewOf([]));
  assert.match(html, /No sources yet - nothing is being swept/);
  assert.doesNotMatch(html, /ts-unknown/);
});

test("task-source defaults offer backlog-compatible kinds and omit chat", () => {
  const source = mkSource();
  const html = renderToStaticMarkup(createElement(SourceCard, {
    src: source,
    kindLabel: "GitHub issues",
    status: undefined,
    repos: [],
    now: Date.now(),
    onChange: () => {},
    onRemove: () => {},
    state: mkState(viewOf([source])),
  }));

  assert.match(html, /<option value="ship" selected="">ship - deliver a change<\/option>/);
  assert.match(html, /<option value="plan">plan - produce a reviewed plan<\/option>/);
  assert.doesNotMatch(html, /<option value="chat"/);
});

test("a source can make swept tasks arrive parked for review", () => {
  const source = mkSource({
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: false },
  });
  const html = renderToStaticMarkup(createElement(SourceCard, {
    src: source,
    kindLabel: "GitHub issues",
    status: undefined,
    repos: [],
    now: Date.now(),
    onChange: () => {},
    onRemove: () => {},
    state: mkState(viewOf([source])),
  }));

  assert.match(html, /aria-label="Allow backlog autopilot to schedule swept tasks"/);
  assert.doesNotMatch(
    html,
    /aria-label="Allow backlog autopilot to schedule swept tasks"[^>]*checked/,
  );
  assert.match(html, /new tasks arrive\s*parked for review/);
});

test("a configured source is a compact overview row with its health", () => {
  const html = render(viewOf([mkSource()]));
  assert.match(html, /widgets bugs/);
  assert.match(html, /GitHub issues/);
  assert.match(html, /Paused/);
  assert.match(html, /Configured task sources/);
  assert.match(html, /role="listitem"><button class="ts-directory-row"/);
  assert.match(
    html,
    /class="tt-desc">Open widgets bugs - paused - \/repo\/widgets<\/span>/,
  );
  assert.doesNotMatch(html, /<button[^>]*role="listitem"/);
});

// "Never swept" and "swept, found nothing" are the two states most easily confused, and
// the confusion is expensive: the first can mean broken since setup.
test("the overview keeps a never-swept enabled source out of the healthy count", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      { sourceId: "src-1", lastSweepAt: null, lastError: null, lastFiled: 0, seenCount: 0, sweeping: false },
    ]),
  );
  assert.match(html, />0<\/strong><span>running normally/);
  assert.match(html, />1<\/strong><span>awaiting first sweep/);
  assert.match(html, /Never swept/);
  assert.match(html, /Pending 1/);
});

test("a sweep that found nothing remains healthy in the overview", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      {
        sourceId: "src-1",
        lastSweepAt: Date.now() - 120_000,
        lastError: null,
        lastFiled: 0,
        seenCount: 4,
        sweeping: false,
      },
    ]),
  );
  assert.match(html, /Healthy/);
  assert.match(html, /Healthy 1/);
});

// A failing source has to be legible as failing. Without this it reads as a source that
// keeps finding nothing, which is what a healthy quiet one looks like.
test("a failed sweep is shown in the attention summary and row", () => {
  const html = render(
    viewOf([mkSource({ enabled: true })], [
      {
        sourceId: "src-1",
        lastSweepAt: Date.now() - 60_000,
        lastError: "gh is not authenticated - run `gh auth login`",
        lastFiled: 0,
        seenCount: 0,
        sweeping: false,
      },
    ]),
  );
  assert.match(html, /need attention/);
  assert.match(html, /Attention:.*1 source had a failed sweep/);
  assert.match(html, /Failed/);
});

// A second kind has to be REACHABLE, not merely implemented: the row says which upstream it
// pulls from, and the type filter offers it, both off the daemon's kinds list rather than a
// list in this file. A source whose kind the panel cannot name reads as a GitHub one.
//
// The editor beside the list - where the Jira site and JQL fields live - is gated on an
// effect that picks a selection, and `renderToStaticMarkup` runs no effects, so this layer
// cannot see it at all. That field group is asserted in a browser instead
// (`e2e/specs/settings-task-sources-jira.spec.ts`), which is where it is reachable.
test("a jira source is named by its own kind, and the type filter offers it", () => {
  const html = render(viewOf([mkSource({ id: "src-2", kind: "jira", label: "platform queue" })]));
  assert.match(html, /platform queue/);
  assert.match(html, /<option value="jira">Jira<\/option>/);
  assert.match(html, /Jira · widgets · every 15 min/);
  assert.match(
    html,
    /class="tt-desc">Open platform queue - paused - \/repo\/widgets<\/span>/,
  );
  assert.doesNotMatch(html, /GitHub issues · /, "the row must not name the other kind's upstream");
});

test("the overview exposes filtering and an add-source entry point", () => {
  const html = render(viewOf([]));
  assert.match(html, /\+ Add source/);
  assert.match(html, /No sources yet - nothing is being swept/);
});

test("health filters expose their pressed state", () => {
  const html = render(viewOf([mkSource()]));
  // `aria-describedby` sits between the class and the pressed state now that each filter
  // says what it filters to, so match the two attributes rather than their adjacency.
  assert.match(html, /class="is-active"[^>]*aria-pressed="true"[^>]*>All 1<\/button>/);
  assert.match(html, /aria-pressed="false"[^>]*>Healthy 0<\/button>/);
  assert.match(html, /aria-pressed="false"[^>]*>Paused 1<\/button>/);
});

// ---- writing back to the item a task was swept from ----
//
// The consent surface for the one direction on this card that changes somebody else's
// tracker. Rendered directly rather than through `TaskSourcesPanel`, for the reason the
// two `SourceCard` cases above are: the editor is gated on an effect that picks a
// selection, and `renderToStaticMarkup` runs none.
//
// Capabilities are passed in as a SYNTHETIC pair throughout, never read off a real kind.
// Each kind's flags flip as its implementation lands, and a test that asserted a shipped
// kind's current values would go red on a change that made the product strictly better -
// while proving nothing about the rendering, which is a function of the booleans and not
// of which kind produced them.
const ABLE = { canAnnotate: true, canResolve: true };
const UNABLE = { canAnnotate: false, canResolve: false };

function queueOf(over: Partial<TaskSourceWritebackStatus> = {}): TaskSourceWritebackStatus {
  return {
    sourceId: "src-1",
    pending: 0,
    failed: 0,
    unknown: 0,
    delivered: 0,
    lastError: null,
    lastDeliveredAt: null,
    ...over,
  };
}

function writeback(
  src: TaskSourceInstance,
  caps: { canAnnotate: boolean; canResolve: boolean },
  queue?: TaskSourceWritebackStatus,
): string {
  return renderToStaticMarkup(
    createElement(WritebackFields, {
      src,
      kindLabel: "GitHub issues",
      caps,
      queue,
      kindFields: null,
      busy: null,
      onChange: () => {},
      onRetry: () => {},
      onDiscard: () => {},
    }),
  );
}

test("the write-back block is anchored, and arrives with every switch off", () => {
  const html = writeback(mkSource(), ABLE);
  assert.match(html, /data-anchor="task-sources\/writeback"/);
  for (const name of [
    "Comment on items from widgets bugs when a pull request opens",
    "Comment on items from widgets bugs when the task completes",
    "Resolve items from widgets bugs when the task completes",
  ]) {
    assert.match(html, new RegExp(`aria-label="${name}"`), `${name} should be offered`);
    assert.doesNotMatch(
      html,
      new RegExp(`aria-label="${name}"[^>]*checked`),
      `${name} must ship off - writing onto somebody else's tracker is consent`,
    );
  }
});

// The claim the whole block rests on, and the one a switch cannot make by itself: what is
// above it only reads, and what is in it writes.
test("the write-back block says these controls write to the upstream", () => {
  const html = writeback(mkSource(), ABLE);
  assert.match(html, /Everything above only <strong>reads<\/strong> the upstream/);
  assert.match(html, /where whoever filed it will see\s*it/);
});

// A resolve with nothing to trigger it is refused by the stored schema, so offering it as
// a live switch would build a body the daemon rejects and then explain the rejection.
test("the resolve switch is unreachable until the completion trigger is on", () => {
  const off = writeback(mkSource(), ABLE);
  assert.match(
    off,
    /disabled="" aria-label="Resolve items from widgets bugs when the task completes"/,
  );
  assert.match(off, /Turn on the completion comment first/);

  const on = writeback(
    mkSource({ writeback: { onPrOpened: false, onCompleted: true, resolve: false } }),
    ABLE,
  );
  assert.doesNotMatch(
    on,
    /disabled="" aria-label="Resolve items from widgets bugs when the task completes"/,
  );
  assert.doesNotMatch(on, /Turn on the completion comment first/);
});

// A capability this build does not have and a switch nobody has turned on are different
// facts. Hidden, they look identical, and an operator goes hunting for a setting that was
// never there - so the switch stays on screen, disabled, saying which it is.
test("a kind that cannot write back renders its switches disabled with the reason", () => {
  const html = writeback(mkSource(), UNABLE);
  assert.match(
    html,
    /disabled="" aria-label="Comment on items from widgets bugs when a pull request opens"/,
  );
  assert.match(html, /GitHub issues cannot write onto its items in this build/);
  assert.match(html, /GitHub issues cannot mark its items resolved in this build/);
});

// `failed` and `unknown` are never summed into "problems": a failure is proof nothing was
// written and is safe to retry, while an unknown outcome may already be a comment on
// somebody's issue. The line and the two buttons both have to be able to say which.
test("the queue line counts what failed apart from what may already have landed", () => {
  const html = writeback(
    mkSource(),
    ABLE,
    queueOf({ pending: 3, failed: 1, unknown: 2, delivered: 7, lastError: "gh refused: no such issue" }),
  );
  assert.match(html, /3 waiting, 1 failed, 2 may already have landed, 7 delivered\./);
  assert.match(html, /gh refused: no such issue/);
  assert.match(html, /Look at the items upstream before retrying those\./);
  assert.match(html, /Retry including unknown/);
});

test("an empty queue offers nothing to retry, but can still be discarded", () => {
  const html = writeback(mkSource(), ABLE, queueOf());
  assert.match(html, /Nothing written back yet\./);
  // Neither retry has a row to act on.
  assert.equal((html.match(/<button class="btn" disabled=""/g) ?? []).length, 2);
  // Discard is not gated on those four counts, because they leave out the deliveries that
  // were called off - and a cancelled row still holds the ledger key that would swallow the
  // same fact as a duplicate if it were observed again.
  assert.match(html, /<button class="btn" aria-describedby="[^"]*">Discard queue<\/button>/);
});

// Before the daemon has answered there is no queue to describe, so nothing claims one.
test("a source with no queue reported yet says so rather than showing an empty one", () => {
  const html = writeback(mkSource(), ABLE);
  assert.match(html, /No queue reported for this source yet\./);
  assert.equal((html.match(/<button class="btn" disabled=""/g) ?? []).length, 3);
});

// The house rule, pinned for the surface this feature owns rather than asserted in review.
//
// "Never use an em dash in project prose" is a repository rule, and the write-back block is
// mostly prose: three switch descriptions, a queue line, a confirm dialog and their comments.
// `test/seed-personas.test.ts` makes the same check for the seeds it ships, and for the same
// reason - a rule that is only ever checked by eye is one that gets argued about instead of
// looked up.
//
// Deliberately NOT repository-wide. Ten files legitimately contain the character as DATA -
// `sdk-delivery.ts` normalizes it out of agent output, `pane-dialog.ts` parses a dialog that
// prints one - and a blanket scan would have to special-case them, which is how a guard stops
// meaning anything. Scoped to the files this change writes prose into.
test("the task sources panel and its write-back surface carry no em dash", () => {
  const EM_DASH = String.fromCharCode(0x2014);
  const EN_DASH = String.fromCharCode(0x2013);
  const files = [
    "src/web/components/TaskSourcesPanel.tsx",
    "src/web/useTaskSources.ts",
    "src/server/settings-status.ts",
    "test/task-sources-panel.test.ts",
    "test/task-source-writeback-http.test.ts",
    "e2e/specs/task-source-writeback.spec.ts",
  ];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!text.includes(EM_DASH), `${file} contains an em dash`);
    assert.ok(!text.includes(EN_DASH), `${file} contains an en dash`);
  }
});

// The Jira write-back field group, which nothing else renders at any layer.
//
// Phase 2 implements Jira's two verbs; the FIELDS that configure them are this phase's, and
// until now no test drew them. Reached through a jira `SourceCard` rather than by exporting
// the sub-component, so the one branch in this panel that names a kind is what selects them -
// which is the thing worth pinning, since a kind whose write-back fields the card forgets to
// compose is a source you cannot configure.
//
// Deliberately says nothing about whether Jira CAN write back. The switches beside these
// fields read that from the registry, Phase 2 flips it, and this test would go red on a
// change that made the product better. What it asserts is that the fields exist and carry
// what is stored.
test("a jira source's write-back fields are composed by the card", () => {
  const source = mkSource({
    id: "src-jira",
    kind: "jira",
    label: "platform queue",
    writeback: { onPrOpened: true, onCompleted: true, resolve: true },
    config: { site: "acme.atlassian.net", jql: "project = MC", resolveTransition: "Shipped", linkVia: "comment" },
  });
  const html = renderToStaticMarkup(createElement(SourceCard, {
    src: source,
    kindLabel: "Jira",
    status: undefined,
    queue: queueOf({ sourceId: "src-jira", pending: 2 }),
    repos: [],
    now: Date.now(),
    onChange: () => {},
    onRemove: () => {},
    state: mkState(viewOf([source])),
  }));

  // The target status a finished issue should land in, as stored.
  assert.match(html, /Target status/);
  assert.match(html, /value="Shipped"/);
  // And how the pull request is attached, with the stored choice selected.
  assert.match(html, /aria-label="How the pull request is attached to a Jira issue"/);
  assert.match(html, /<option value="comment" selected="">Comment only<\/option>/);
  // The GitHub kind's own write-back field must NOT be here: a source configured with
  // another upstream's control is one whose resolve can never do what it says.
  assert.doesNotMatch(html, /How a resolved GitHub issue is closed/);
  // The queue line still reads this source's own row.
  assert.match(html, /2 waiting\./);
});

// A stored-but-empty target status is a switch that looks configured and refuses every time
// it fires, which is exactly the failure the empty-JQL warning above it exists to prevent.
test("a jira source resolving with no target status says so before it ever fires", () => {
  const resolving = mkSource({
    id: "src-jira",
    kind: "jira",
    writeback: { onPrOpened: false, onCompleted: true, resolve: true },
    config: { jql: "project = MC", resolveTransition: "" },
  });
  const html = renderToStaticMarkup(createElement(SourceCard, {
    src: resolving,
    kindLabel: "Jira",
    status: undefined,
    queue: queueOf({ sourceId: "src-jira" }),
    repos: [],
    now: Date.now(),
    onChange: () => {},
    onRemove: () => {},
    state: mkState(viewOf([resolving])),
  }));
  assert.match(html, /Without a target status nothing can be resolved/);

  // Not resolving: the same empty field is simply a setting nobody has needed yet, and
  // warning about it would train the operator to ignore the warning.
  const idle = mkSource({
    id: "src-jira",
    kind: "jira",
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
    config: { jql: "project = MC", resolveTransition: "" },
  });
  const quiet = renderToStaticMarkup(createElement(SourceCard, {
    src: idle,
    kindLabel: "Jira",
    status: undefined,
    queue: queueOf({ sourceId: "src-jira" }),
    repos: [],
    now: Date.now(),
    onChange: () => {},
    onRemove: () => {},
    state: mkState(viewOf([idle])),
  }));
  assert.doesNotMatch(quiet, /Without a target status nothing can be resolved/);
});

// The GitHub kind's own write-back field, on the same terms.
test("a github source's close reason is composed by the card and carries what is stored", () => {
  const source = mkSource({ config: { closeReason: "not-planned" } });
  const html = renderToStaticMarkup(createElement(SourceCard, {
    src: source,
    kindLabel: "GitHub issues",
    status: undefined,
    queue: queueOf(),
    repos: [],
    now: Date.now(),
    onChange: () => {},
    onRemove: () => {},
    state: mkState(viewOf([source])),
  }));
  assert.match(html, /aria-label="How a resolved GitHub issue is closed"/);
  assert.match(html, /<option value="not-planned" selected="">Not planned<\/option>/);
  assert.doesNotMatch(html, /Target status/);
});
