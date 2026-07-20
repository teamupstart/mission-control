import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForemanSettingsPanel,
  candidateRepos,
} from "../src/web/components/ForemanSettingsPanel.tsx";
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
  return renderToStaticMarkup(createElement(ForemanSettingsPanel, { state }));
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

test("each trusted repo renders a row with a remove control", () => {
  const html = renderPanel(mkState({ repoAllowlist: ["/work/alpha", "/work/beta"] }));
  assert.match(html, /\/work\/alpha/);
  assert.match(html, /\/work\/beta/);
  // One remove button per repo, labelled with the path it drops.
  assert.match(html, /aria-label="Stop trusting \/work\/alpha"/);
  assert.match(html, /aria-label="Stop trusting \/work\/beta"/);
});

test("an empty allowlist shows the 'no repos' state, not an empty list", () => {
  const html = renderPanel(mkState({ repoAllowlist: [] }));
  // (apostrophe is HTML-escaped in static markup, so match around it)
  assert.match(html, /No repos yet - Foreman won.{0,8}t act live anywhere/);
  assert.doesNotMatch(html, /foreman-repo-row/);
});

test("the add row renders the repo picker and an Add button", () => {
  const html = renderPanel(mkState());
  assert.match(html, /placeholder="search repos or type a path…"/);
  assert.match(html, /<button[^>]*>Add<\/button>/);
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
