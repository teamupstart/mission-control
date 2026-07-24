import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForemanSettingsPanel } from "../src/web/components/ForemanSettingsPanel.tsx";
import { candidateRepos } from "../src/web/lib/trust.ts";
import { ForemanPopover } from "../src/web/components/ForemanBar.tsx";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";

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
  wrapupTriggers: ["drain"],
  wrapup: "ask",
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
    update: async () => {},
    error: null,
  };
}

function renderPanel(state: ForemanState): string {
  return renderToStaticMarkup(
    createElement(ForemanSettingsPanel, { state, onNavigate: () => {} }),
  );
}

// ---- ForemanSettingsPanel ----

test("the Tier control lists all three cheap-tier options", () => {
  const html = renderPanel(mkState());
  assert.match(html, /Off - full review for every prompt/);
  assert.match(html, /Shadow - run the cheap tier alongside, measure it/);
  assert.match(html, /On - cheap tier answers the easy ones/);
});

test("exactly one tier option is checked, following config.triage", () => {
  // The panel has no other checkable input, so the lone `checked` is the tier selection.
  const shadow = renderPanel(mkState({ triage: "shadow" }));
  assert.equal((shadow.match(/checked/g) ?? []).length, 1);
  assert.match(shadow, /checked[^]*?Shadow - run the cheap tier/);

  const on = renderPanel(mkState({ triage: "on" }));
  assert.equal((on.match(/checked/g) ?? []).length, 1);
  assert.match(on, /checked[^]*?On - cheap tier answers/);
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

test("Foreman provider and every model are catalog-backed dropdowns", () => {
  const html = renderPanel(mkState({ runner: "codex" }));
  assert.match(html, /id="foreman-provider"/);
  assert.match(html, /<option value="codex" selected="">Codex<\/option>/);
  for (const id of ["foreman-model-review", "foreman-model-verify", "foreman-model-triage", "foreman-model-backlog"]) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"`));
  }
  assert.match(html, /GPT-5\.6 Sol/);
  assert.doesNotMatch(html, /Claude Code provider/);
});

test("Foreman exposes separate compatible defaults for fresh backlog launches", () => {
  const html = renderPanel(mkState());
  assert.match(html, /Backlog launch models/);
  assert.match(html, /id="foreman-backlog-task-model-claude"/);
  assert.match(html, /id="foreman-backlog-task-model-codex"/);
  assert.match(html, /already names one/);
  assert.match(html, /existing session.{0,50}unchanged/);
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

test("the wrap-up trigger group is a multi-select, and the action stays a radio group", () => {
  // The whole point of the split: any number of moments, exactly one action. A regression
  // to radios for the triggers would silently make the two mutually exclusive, and a
  // regression to checkboxes for the action would let someone pick both `/no-mistakes`
  // and `pr` - two pushes racing on one branch.
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
  assert.equal((html.match(/name="foreman-wrapup"/g) ?? []).length, 3, "one radio group of 3");
  assert.match(html, /Straight to PR - skip no-mistakes/);
});

test("with no trigger armed the action group is disabled and says so", () => {
  // An empty list is a real choice, not an unset value, so the UI has to render it as
  // one: radios that still look live would promise an action at a moment that never
  // arrives.
  const html = renderPopover(mkState({ wrapupTriggers: [] }));
  assert.match(html, /Foreman never wraps up on its own/);
  assert.match(html, /<fieldset class="foreman-wrapup-action" disabled=""/);
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
