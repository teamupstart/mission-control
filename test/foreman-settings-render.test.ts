import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForemanSettingsPanel } from "../src/web/components/ForemanSettingsPanel.tsx";
import { candidateRepos } from "../src/web/lib/trust.ts";
import { ForemanPopover } from "../src/web/components/ForemanBar.tsx";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "../src/shared/foreman-models.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import { ForemanConfigSchema } from "../src/shared/protocol.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { ForemanStatus } from "../src/shared/types.ts";

// Static markup, per the repo convention (the SSE stream hangs headless automation). The
// panel's picker candidates arrive via an effect that static render never runs, so the
// candidate-filtering logic is proven directly through the exported `candidateRepos`.

const BASE: ForemanConfig = {
  enabled: true,
  mode: "live",
  repoAllowlist: ["/work/alpha", "/work/beta"],
  autoApproveAccess: true,
  triage: "shadow",
  maxFixAttempts: 3,
  maxFixRounds: 10,
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
  wrapupTriggers: ["drain"],
  wrapup: "ask",
  trackReviewFeedback: true,
  trackCiFailures: true,
  keepShipTasksMoving: true,
  shipRecoveryMinutes: 20,
  autoBacklog: false,
  backlogRespectOpenPrs: true,
  backlogDefaultModel: { claude: null, codex: null, pi: null },
  maxSessions: 3,
};

function mkState(over: Partial<ForemanConfig> = {}): ForemanState {
  return {
    config: { ...BASE, ...over },
    status: null,
    backlogPlan: null,
    episodes: [],
    update: async () => true,
    refresh: async () => {},
    error: null,
  };
}

function plannerStatus(): ForemanStatus {
  return {
    enabled: true,
    mode: "live",
    running: true,
    queueDepth: 0,
    counts: { answered: 0, escalated: 0, pending: 0, skipped: 0 },
    lastActionAt: null,
    autopilot: { on: true, active: 6, max: 9, ready: 6, blocked: 6, disabled: 0 },
    planner: {
      state: "degraded",
      runner: "codex",
      model: "gpt-5.6-terra",
      failureCount: 3,
      lastError: "codex exited 1: schema validation failed",
      nextRetryAt: Date.now() + 600_000,
    },
    instructionsSource: "builtin",
  } as ForemanStatus;
}

function renderPanel(state: ForemanState): string {
  return renderToStaticMarkup(
    createElement(ForemanSettingsPanel, { state, onNavigate: () => {} }),
  );
}

function inputWithLabel(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<input[^>]*aria-label="${escaped}"[^>]*>`))?.[0] ?? "";
}

/** Static-markup entities decoded, so assertions pin the copy rather than its escaping. */
function decoded(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---- ForemanSettingsPanel ----

test("standing guidance reports the status source and links to the one System profile", () => {
  const expected = [
    ["builtin", "Built-in default"],
    ["custom", "Customized"],
    ["none", "No standing guidance"],
  ] as const;
  for (const [instructionsSource, label] of expected) {
    const state = mkState();
    state.status = { ...plannerStatus(), instructionsSource };
    const html = renderPanel(state);
    assert.match(html, new RegExp(label));
    assert.match(html, />Open System profile<\/button>/);
    assert.match(html, /Identity, policy,[\s\S]*authority remain application-owned/);
  }
});

test("standing guidance is unknown until status answers instead of assuming a source", () => {
  const html = renderPanel(mkState());
  assert.match(html, /Standing guidance/);
  assert.match(html, /Unknown - the daemon has not answered/);
  assert.doesNotMatch(html, /Built-in default/);
});

test("the Tier control lists all three cheap-tier options", () => {
  const html = renderPanel(mkState());
  assert.match(html, /Off - full review for every prompt/);
  assert.match(html, /Shadow - run the cheap tier alongside, measure it/);
  assert.match(html, /On - cheap tier answers the easy ones/);
});

test("exactly one tier option is checked, following config.triage", () => {
  const shadow = renderPanel(mkState({ triage: "shadow" }));
  // Sliced to the next PANEL rather than to `foreman/provider`, which used to be the first
  // anchor after the tier control and now lives on Settings > Models.
  const shadowGroup = shadow.slice(
    shadow.indexOf('data-anchor="foreman/cheap-tier"'),
    shadow.indexOf('id="foreman-settings-panel-launches"'),
  );
  assert.equal((shadowGroup.match(/checked/g) ?? []).length, 1);
  assert.match(shadowGroup, /checked[^]*?Shadow - run the cheap tier/);

  const on = renderPanel(mkState({ triage: "on" }));
  const onGroup = on.slice(
    on.indexOf('data-anchor="foreman/cheap-tier"'),
    on.indexOf('id="foreman-settings-panel-launches"'),
  );
  assert.equal((onGroup.match(/checked/g) ?? []).length, 1);
  assert.match(onGroup, /checked[^]*?On - cheap tier answers/);
});

function tierGroup(html: string): string {
  return html.slice(
    html.indexOf('data-anchor="foreman/cheap-tier"'),
    html.indexOf('id="foreman-settings-panel-launches"'),
  );
}

test("a fresh install draws On, and no shadow-promotion advice under it", () => {
  // Rendered from the SCHEMA's own defaults rather than from this file's fixture, so the
  // panel's readout and what the daemon actually enforces cannot drift apart silently: parse
  // an empty object and the posture an operator reads is the posture their worker runs.
  const fresh = tierGroup(renderPanel({ ...mkState(), config: ForemanConfigSchema.parse({}) }));

  assert.equal((fresh.match(/checked/g) ?? []).length, 1);
  assert.match(fresh, /checked[^]*?On - cheap tier answers/);
  // The "promote it to On once over-eager has stayed at zero" note belongs to the posture
  // that measures. Shipped under On it would be advice to make a change already made.
  assert.doesNotMatch(fresh, /Promote it to <b>On<\/b>|Promote it to/);
});

test("a config that has not loaded yet shows the default posture, disabled", () => {
  // The Harnesses runtime row refuses to guess while its read is in flight; this control
  // cannot, because a radio group has to draw SOMETHING. So it draws what the daemon applies
  // to an unanswered config and locks the group until the real value lands - never a posture
  // the server is not running.
  const group = tierGroup(renderPanel({ ...mkState(), config: null }));

  assert.match(group, /checked[^]*?On - cheap tier answers/);
  assert.equal((group.match(/disabled=""/g) ?? []).length, 3);
});

// The repo editor moved to the Trust matrix; the panel now summarizes the grant and
// deep-links there. What must survive is the COUNT (so "am I live anywhere" is still
// answerable here) and the link (so it is a route change, not a prose instruction), and
// the editor must be gone so two surfaces cannot write the same list.
test("the live-repos section is a grant count that deep-links to Trust, not an editor", () => {
  const html = renderPanel(mkState({ repoAllowlist: ["/work/alpha", "/work/beta"] }));
  assert.match(html, /Foreman may send live in 2 repositories/);
  assert.match(html, /Manage in Trust/);
  // No inline editor: no picker, no per-repo remove buttons, no Add.
  assert.doesNotMatch(html, /placeholder="search repos or type a path…"/);
  assert.doesNotMatch(html, /aria-label="Stop trusting/);
  assert.doesNotMatch(html, /foreman-repo-row/);
});

test("one trusted repo reads in the singular", () => {
  const html = renderPanel(mkState({ repoAllowlist: ["/work/alpha"] }));
  assert.match(html, /Foreman may send live in 1 repository\b/);
});

test("with no answer from the daemon the count is unknown, not zero", () => {
  const html = renderToStaticMarkup(
    createElement(ForemanSettingsPanel, {
      state: { ...mkState(), config: null },
      onNavigate: () => {},
    }),
  );
  assert.match(html, /Unknown - the daemon hasn.{0,8}t said which repos are trusted/);
  assert.doesNotMatch(html, /0 repositories grant/);
});

// Foreman's provider and its four role models moved to Settings > Models, where every
// app-owned model choice is answerable in one screen. What has to be true HERE is the
// negative - the controls are gone, so two panels cannot write the same keys and search
// cannot have two places to send one operator - plus a pointer that survives a bookmark.
// The controls themselves are asserted in `foreman-models-panel.test.ts`.
test("Foreman's own provider and model controls are gone, leaving a pointer", () => {
  const html = renderPanel(mkState({ runner: "codex" }));
  assert.doesNotMatch(html, /id="foreman-provider"/);
  for (const id of ["foreman-model-review", "foreman-model-verify", "foreman-model-triage", "foreman-model-backlog"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Open them in Models/);
  // Named, so the pointer says which of Foreman's models moved and which did not.
  assert.match(html, /Review, Verify, Triage and the Backlog[\s\S]*dependency planner/);
});

test("Foreman exposes separate compatible defaults for fresh backlog launches", () => {
  const html = renderPanel(mkState());
  assert.match(html, />Launches<\/h3>/);
  assert.match(html, /id="foreman-backlog-task-model-claude"/);
  assert.match(html, /id="foreman-backlog-task-model-codex"/);
  assert.match(html, /already names one/);
  assert.match(html, /existing session.{0,50}unchanged/);
  assert.match(html, /unrelated to the Backlog[\s\S]*dependency planner/);
});

test("the pointer keeps the backlog LAUNCH models distinct from the four that moved", () => {
  // The confusion this line exists to prevent: both are "Foreman models" by name, and only
  // one set is a call Foreman makes on its own account. The other chooses what a launched
  // agent runs as, which is the dispatch ladder, and it stays here.
  const html = renderPanel(mkState({ runner: "codex" }));
  assert.match(html, /now live with every other model this app spends on/);
  assert.match(html, /stay on <strong>Launches<\/strong>/);
  assert.match(html, /id="foreman-backlog-task-model-claude"/);
});

// ---- the prose is printed once, not twice ----
// Each field's explanation lives in its Tooltip, which fires on hover and on focus and
// always renders a hidden `tt-desc` copy the trigger's aria-describedby points at. What
// these tests pin is both halves of that move: the visible duplicate is gone, and every
// sentence is still in the markup - moved, never deleted.

test("the model blurbs render tooltip-only in Foreman - no visible duplicate, no lost sentence", () => {
  const html = decoded(renderPanel(mkState()));
  assert.doesNotMatch(html, /foreman-model-blurb/);
  for (const agent of ["Claude", "Codex", "Pi"]) {
    assert.ok(
      html.includes(`Used when Foreman launches an unpinned ${agent} task from the backlog.`),
      `the ${agent} backlog blurb went missing`,
    );
  }
});

test("the pointer to Models is reachable from any tab, not buried inside one", () => {
  // A bookmark or a keyboard walk that expected the Models tab now lands on Posture, so the
  // signpost has to be outside the tab strip - inside a tabpanel it would be hidden exactly
  // when it is needed. It carries no `data-anchor`: search points at the Models page itself.
  const html = decoded(renderPanel(mkState()));
  const beforeStrip = html.slice(0, html.indexOf('role="tablist"'));
  assert.match(beforeStrip, /Open them in Models/);
  assert.doesNotMatch(html, /data-anchor="foreman\/provider"/);
});

test("the safeguard descriptions are tooltip-only while their labels stay printed", () => {
  const html = decoded(renderPanel(mkState()));
  assert.doesNotMatch(html, /kb-row-desc/);
  assert.ok(html.includes(
    "Uses the task's durable Kind. The scout's findings remain the finished output.",
  ));
  assert.ok(html.includes(
    "Reads the resolved objective and artifact-only changed paths. Mixed work that also requests implementation still follows the normal completion action.",
  ));
});

test("the two group intros stay visible paragraphs - one per group, not one per field", () => {
  const html = decoded(renderPanel(mkState()));
  assert.match(html, /<p class="settings-hint">When Foreman starts a fresh backlog task/);
  assert.match(html, /<p class="settings-hint">Choose which finished work Foreman retires/);
});

test("completion safeguards render as independent default-on settings", () => {
  const html = renderPanel(mkState());
  assert.match(html, />Safety<\/h3>/);
  for (const label of [
    "Skip automatic completion for Scout tasks",
    "Skip automatic completion for mockups and review artifacts",
  ]) {
    const input = inputWithLabel(html, label);
    assert.notEqual(input, "", label);
    assert.match(input, /checked/);
  }
  assert.match(html, /matching either enabled safeguard/);
});

test("completion safeguards show persisted off values and old-daemon defaults honestly", () => {
  const off = renderPanel(mkState({
    skipScoutWrapup: false,
    skipReviewArtifactWrapup: false,
  }));
  for (const label of [
    "Skip automatic completion for Scout tasks",
    "Skip automatic completion for mockups and review artifacts",
  ]) {
    assert.doesNotMatch(inputWithLabel(off, label), /checked/);
  }

  const state = mkState();
  delete (state.config as Partial<ForemanConfig>).skipScoutWrapup;
  delete (state.config as Partial<ForemanConfig>).skipReviewArtifactWrapup;
  const oldDaemon = renderPanel(state);
  for (const label of [
    "Skip automatic completion for Scout tasks",
    "Skip automatic completion for mockups and review artifacts",
  ]) {
    assert.match(inputWithLabel(oldDaemon, label), /checked/);
  }
});

// ---- candidate filtering ----

test("candidateRepos offers known repos that aren't trusted yet, and omits ones that are", () => {
  const repos = ["/work/alpha", "/work/beta", "/work/gamma"];
  const got = candidateRepos(repos, ["/work/beta"]);
  assert.deepEqual(got, ["/work/alpha", "/work/gamma"]);
  // Nothing new to offer once every known repo is trusted.
  assert.deepEqual(candidateRepos(repos, repos), []);
});

// ---- ForemanPopover: the trimmed quick-settings popover ----

function renderPopover(state: ForemanState): string {
  return renderToStaticMarkup(
    createElement(ForemanPopover, { state, onOpenSettings: () => {} }),
  );
}

test("the popover keeps the in-the-moment knobs", () => {
  const html = renderPopover(mkState());
  assert.match(html, /Enable Foreman/);
  assert.match(html, /<legend>Mode<\/legend>/);
  assert.match(html, /<legend>Work queues<\/legend>/);
  assert.match(html, /<legend>Trigger on<\/legend>/);
  assert.match(html, /<legend>Then<\/legend>/);
});

test("the backlog group carries the open-PR guard, checked by default", () => {
  // The knob exists so the refusal is visible and reversible. A guard that silently
  // withheld agents from the backlog with nothing on screen saying so would read as the
  // autopilot being broken - which is exactly the report it would generate.
  const html = renderPopover(mkState({ autoBacklog: true }));
  assert.match(html, /<legend>Backlog<\/legend>/);
  assert.match(html, /Open PRs keep an idle agent off the backlog/);
  // The checkbox before that label is the one carrying `backlogRespectOpenPrs`.
  const at = html.indexOf("Open PRs keep an idle agent off the backlog");
  assert.match(html.slice(0, at).split("<input").pop() ?? "", /checked/);
});

test("a daemon too old to know the guard still renders it as on, matching what it does", () => {
  // A web build ahead of the daemon gets no such key. Rendering it unticked would have
  // the panel swear the guard is off while the server applies it - and the report that
  // generates is "autopilot is ignoring my idle agent", with the explanation on screen
  // saying the opposite.
  const state = mkState();
  delete (state.config as Partial<ForemanConfig>).backlogRespectOpenPrs;
  const html = renderPopover(state);
  const at = html.indexOf("Open PRs keep an idle agent off the backlog");
  assert.match(html.slice(0, at).split("<input").pop() ?? "", /checked/);
});

test("turning the open-PR guard off says what that now allows", () => {
  const html = renderPopover(mkState({ autoBacklog: true, backlogRespectOpenPrs: false }));
  assert.match(html, /can be handed the next task/);
  // And the hint is not shown while the guard is on - it would describe the opposite of
  // what is happening.
  assert.doesNotMatch(renderPopover(mkState({ autoBacklog: true })), /can be handed the next task/);
});

test("a degraded dependency planner names its runtime, safe error, and retry path", () => {
  const state = mkState({ autoBacklog: true, runner: "codex" });
  state.status = plannerStatus();
  const html = renderPopover(state);
  assert.match(html, /Backlog dependency planner health/);
  assert.match(html, /Dependency planner/);
  assert.match(html, /degraded/);
  assert.match(html, /codex/);
  assert.match(html, /gpt-5\.6-terra/);
  assert.match(html, /3 failures/);
  assert.match(html, /schema validation failed/);
  assert.match(html, /Retry planner now/);
});

test("settings call the dependency planner idle while backlog autopilot is off", () => {
  const state = mkState({ autoBacklog: false, runner: "codex" });
  const status = plannerStatus();
  status.autopilot = { ...status.autopilot, on: false };
  state.status = status;

  const html = renderPanel(state);
  assert.match(html, /idle \(autopilot off\) · codex\/gpt-5\.6-terra/);
  assert.doesNotMatch(html, /degraded · codex\/gpt-5\.6-terra/);
});

test("the wrap-up trigger group is a multi-select, and Then has no automatic review mode", () => {
  // The whole point of the split: any number of moments, exactly one action. A regression
  // to radios for the triggers would silently make the two mutually exclusive, and a
  // regression to checkboxes for the action would let someone pick both Ask and direct
  // PR, with two shipping paths racing on one branch.
  const html = renderPopover(mkState({ wrapupTriggers: ["drain", "prompted"] }));
  // Scoped to the trigger fieldset: counting checkboxes across the whole popover also
  // catches Enable Foreman and Auto-approve, which would make this pass for the wrong
  // reason (and did).
  const group = html.slice(html.indexOf("<legend>Trigger on"), html.indexOf("<legend>Then"));
  assert.equal(
    (group.match(/type="checkbox"[^>]*checked=""/g) ?? []).length,
    2,
    "both triggers tick independently",
  );
  assert.doesNotMatch(group, /type="radio"/, "triggers are never mutually exclusive");
  assert.equal((html.match(/name="foreman-wrapup"/g) ?? []).length, 2, "one radio group of 2");
  assert.doesNotMatch(html, /Run No-Mistakes Review automatically/);
  assert.match(html, /Straight to PR - when no Workflow is bound/);
});

test("with no trigger armed the action group is disabled and says so", () => {
  // An empty list is a real choice, not an unset value, so the UI has to render it as
  // one: radios that still look live would promise an action at a moment that never
  // arrives.
  const html = renderPopover(mkState({ wrapupTriggers: [] }));
  assert.match(html, /Foreman never wraps up on its own/);
  assert.match(html, /<fieldset class="foreman-wrapup-action" disabled=""/);
});

test("pre-PR recovery, review comments, and CI render as independent default-on settings", () => {
  const html = renderPopover(mkState());
  assert.match(html, /<legend>Pull requests<\/legend>/);
  for (const label of [
    "Keep pre-PR ship tasks moving",
    "Keep sessions on track with review comments",
    "Keep sessions on track with CI",
  ]) {
    const at = html.indexOf(label);
    assert.notEqual(at, -1, label);
    assert.match(html.slice(0, at).split("<input").pop() ?? "", /checked/, label);
  }
  assert.match(html, /Invited managed Ship tasks only, in Live trusted repos/);
  assert.match(html, /Stops as soon as any\s+task-owned pull request appears/);
  assert.match(html, /Does not create a PR\. Once one exists, sends failing CI back to its session/);
});

test("the two PR follow-through permissions persist independently", () => {
  const commentsOnly = renderPopover(mkState({
    trackReviewFeedback: true,
    trackCiFailures: false,
  }));
  const commentsAt = commentsOnly.indexOf("Keep sessions on track with review comments");
  const ciAt = commentsOnly.indexOf("Keep sessions on track with CI");
  assert.match(commentsOnly.slice(0, commentsAt).split("<input").pop() ?? "", /checked/);
  assert.doesNotMatch(commentsOnly.slice(0, ciAt).split("<input").pop() ?? "", /checked/);
});

test("a daemon too old to know the follow-through keys still renders them as on", () => {
  // Same failure the backlog guard guards against: a web build ahead of the daemon gets no
  // key, and an unticked box would swear the feature is off while the server runs it on.
  const state = mkState();
  delete (state.config as Partial<ForemanConfig>).trackReviewFeedback;
  delete (state.config as Partial<ForemanConfig>).trackCiFailures;
  delete (state.config as Partial<ForemanConfig>).keepShipTasksMoving;
  const html = renderPopover(state);
  for (const label of [
    "Keep pre-PR ship tasks moving",
    "Keep sessions on track with review comments",
    "Keep sessions on track with CI",
  ]) {
    const at = html.indexOf(label);
    assert.match(html.slice(0, at).split("<input").pop() ?? "", /checked/, label);
  }
});

test("Foreman Safety renders the bounded recovery threshold and fixed retry policy", () => {
  const html = renderPanel(mkState({ shipRecoveryMinutes: 37 }));
  assert.match(html, /Pre-PR ship recovery/);
  assert.match(html, /value="37"/);
  assert.match(html, /Quiet minutes before first recovery/);
  assert.match(html, /fixed 40 and 80 minutes/);
  assert.match(html, /After three sends Foreman\s+escalates without typing again/);
});

test("the follow-through hint warns when it cannot type outside Live mode", () => {
  assert.match(renderPopover(mkState({ mode: "dry-run" })), /a parked PR is left\s+for you/);
  // In live mode the caveat is gone - it would describe the opposite of what happens.
  assert.doesNotMatch(renderPopover(mkState({ mode: "live" })), /a parked PR is left/);
});

test("the popover no longer holds Tier or a paste-a-path allowlist", () => {
  const html = renderPopover(mkState());
  assert.doesNotMatch(html, /Cheap tier/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /one path per line/);
});

test("Live mode shows a read-only repo count that links to Settings", () => {
  const live = renderPopover(mkState({ mode: "live", repoAllowlist: ["/work/alpha", "/work/beta"] }));
  assert.match(live, /Live in 2 repos · manage in Settings/);

  const liveEmpty = renderPopover(mkState({ mode: "live", repoAllowlist: [] }));
  assert.match(liveEmpty, /no repos trusted yet - add them in Settings/);

  // Not live: no allowlist summary in the popover at all.
  const dry = renderPopover(mkState({ mode: "dry-run" }));
  assert.doesNotMatch(dry, /manage in Settings/);
});
