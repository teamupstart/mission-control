import { test } from "node:test";
import assert from "node:assert/strict";
import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import type { MissionSchedule } from "../src/shared/schedules.ts";
import type {
  PersonaView,
  SessionAction,
  WorkflowRunSummary,
  WorkflowSummary,
} from "../src/shared/workflow.ts";
import {
  nextPaletteKind,
  PALETTE_KINDS,
  PALETTE_KIND_INFO,
  paletteKindGroup,
  paletteRowHint,
  paletteRows,
  searchPalette,
  type PaletteKind,
  type PaletteRow,
  type PaletteStores,
} from "../src/web/lib/palette-index.ts";
import { SETTINGS_CONTROLS } from "../src/web/lib/settings-search.ts";
import { SETTINGS_CATEGORIES } from "../src/web/lib/settings-registry.ts";
import { ACTIONS } from "../src/web/lib/keybindings.ts";

// What is at stake: the palette is the app's only cross-home search, so an asset that fails
// to appear here is an asset an operator cannot find by name at all - and a row that appears
// but points somewhere stale is worse, because it navigates confidently to the wrong place.
//
// So the load-bearing cases below are: every provider's filter (an archived asset must not be
// offered a card that no longer exists), every row's destination (a route the app publishes,
// or an affordance it already has), and the live-state line (read from the store, not
// re-derived - a run that says "Completed" while the Runs page says "Blocked" would make the
// palette a second, wrong answer).
//
// No DOM here. `palette-render.test.ts` covers what the component draws.

const NOW = 1_770_000_000_000;

function workflow(over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id: "wf-1",
    name: "No-Mistakes Review",
    description: "Reviews the diff and loops repairs back.",
    draftRevision: 3,
    currentVersionId: "wfv-1",
    publishedVersion: 8,
    archivedAt: null,
    updatedAt: NOW,
    errorCount: 0,
    warningCount: 0,
    nodeCount: 6,
    personaCount: 2,
    builtin: true,
    ...over,
  };
}

function run(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run-1",
    bindingId: "bind-1",
    workflowId: "wf-1",
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    sessionId: "sess-1",
    noteKey: "note",
    status: "waiting_for_session",
    phase: "repair",
    round: 2,
    maxRepairRounds: 3,
    activePersonaNames: [],
    failedPersonaCount: 1,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    updatedAt: NOW,
    ...over,
  };
}

function ensemble(over: Partial<EnsembleSummary> = {}): EnsembleSummary {
  return {
    id: "ens-1",
    title: "refactor-discovery",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "awaiting_decision",
    activeStageId: null,
    memberCount: 3,
    launchedMembers: 3,
    maxMembers: 3,
    readyArtifacts: 3,
    membersOut: 0,
    membersNeedingInput: 0,
    membersReady: 3,
    selectedMemberId: null,
    outcomeKind: null,
    unreadable: null,
    attention: true,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...over,
  };
}

function persona(over: Partial<PersonaView> = {}): PersonaView {
  return {
    id: "per-1",
    name: "Code Risk Reviewer",
    normalizedName: "code risk reviewer",
    description: "Reads the diff for risk.",
    guidanceMarkdown: "# Risk",
    runner: null,
    model: null,
    revision: 1,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    builtin: true,
    execution: {
      runner: { id: "claude", source: "default", unknown: null },
      model: { id: "sonnet", source: "default" },
    },
    ...over,
  };
}

function action(over: Partial<SessionAction> = {}): SessionAction {
  return {
    id: "act-1",
    name: "Open a pull request",
    normalizedName: "open a pull request",
    description: "Push and open the PR.",
    promptMarkdown: "# PR",
    requiredSkillId: null,
    completion: { kind: "pull_request" },
    revision: 1,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    builtin: true,
    ...over,
  };
}

function schedule(over: Partial<MissionSchedule> = {}): MissionSchedule {
  return {
    id: "sch-1",
    name: "Dependency audit",
    enabled: true,
    archivedAt: null,
    expression: "0 8 * * 1",
    timezone: "UTC",
    overlapPolicy: null,
    missedPolicy: null,
    executionMode: null,
    runnerId: null,
    revision: 1,
    template: null,
    nextRunAt: NOW,
    lastOccurrence: null,
    unreadable: null,
    health: "healthy",
    healthReasons: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function stores(over: Partial<PaletteStores> = {}): PaletteStores {
  return {
    workflows: [],
    runs: [],
    ensembles: [],
    personas: [],
    sessionActions: [],
    schedules: [],
    sessionNames: new Map(),
    settingsBindings: new Map(),
    ...over,
  };
}

function find(rows: PaletteRow[], id: string): PaletteRow {
  const row = rows.find((r) => r.id === id);
  assert.ok(row, `no row with id "${id}" among ${rows.map((r) => r.id).join(", ")}`);
  return row;
}

// ---- the registry ----------------------------------------------------------

test("every kind has chip metadata, and its group is derived rather than chosen per row", () => {
  for (const kind of PALETTE_KINDS) {
    const info = PALETTE_KIND_INFO[kind];
    assert.ok(info, `kind "${kind}" has no chip metadata`);
    assert.equal(info.id, kind);
    assert.ok(info.label.length > 0, `kind "${kind}" has no chip label`);
    assert.ok(info.glyph.length > 0, `kind "${kind}" has no glyph`);
    assert.equal(paletteKindGroup(kind), info.group);
  }
});

test("no two rows share an id, across every provider", () => {
  const rows = paletteRows(
    stores({
      workflows: [workflow()],
      runs: [run()],
      ensembles: [ensemble()],
      personas: [persona()],
      sessionActions: [action()],
      schedules: [schedule()],
    }),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    assert.ok(!seen.has(row.id), `duplicate palette row id "${row.id}"`);
    seen.add(row.id);
  }
});

test("every row says what enter will do, naming a real destination", () => {
  const rows = paletteRows(
    stores({
      workflows: [workflow()],
      runs: [run()],
      ensembles: [ensemble()],
      personas: [persona()],
      sessionActions: [action()],
      schedules: [schedule()],
      settingsBindings: new Map([["format-messages", { get: () => false, set: () => {} }]]),
    }),
  );
  for (const row of rows) {
    assert.ok(paletteRowHint(row).trim().length > 0, `${row.id} has no hover description`);
  }
  assert.match(paletteRowHint(find(rows, "run:run-1")), /^Open in Workflow runs - /);
  assert.match(paletteRowHint(find(rows, "workflow:wf-1")), /^Open in the Library - /);
  assert.match(paletteRowHint(find(rows, "setting:soak")), /^Open in Shipping settings - /);
  // The switch says which way it will move, so a keyboard user hears the consequence rather
  // than the current state.
  assert.equal(
    paletteRowHint(find(rows, "setting:format-messages")).startsWith("Switch on here"),
    true,
  );
});

test("every row says something about itself, and lands somewhere", () => {
  const rows = paletteRows(
    stores({
      workflows: [workflow()],
      runs: [run()],
      ensembles: [ensemble()],
      personas: [persona()],
      sessionActions: [action()],
      schedules: [schedule()],
    }),
  );
  for (const row of rows) {
    assert.ok(row.title.trim().length > 0, `${row.id} has no title`);
    // A row with no second line is a name with no reason to pick it - the palette exists to
    // say what the thing IS or is doing, not merely that it exists.
    assert.ok(row.detail.trim().length > 0, `${row.id} has no detail line`);
    assert.ok(row.target, `${row.id} has no target`);
  }
});

// ---- the Library providers -------------------------------------------------

test("an archived asset never appears - the shelf it would land on does not list it", () => {
  const rows = paletteRows(
    stores({
      workflows: [workflow({ id: "wf-live" }), workflow({ id: "wf-old", archivedAt: NOW })],
      personas: [persona({ id: "per-live" }), persona({ id: "per-old", archivedAt: NOW })],
      // The session-action store deliberately KEEPS archived rows (they arrive as an upsert,
      // not a remove, so a published version can still name its source), which is exactly why
      // this filter has to be here and not assumed upstream.
      sessionActions: [action({ id: "act-live" }), action({ id: "act-old", archivedAt: NOW })],
      schedules: [schedule({ id: "sch-live" }), schedule({ id: "sch-old", archivedAt: NOW })],
    }),
  );
  const ids = rows.map((row) => row.id);
  for (const live of ["workflow:wf-live", "persona:per-live", "action:act-live", "mission:sch-live"]) {
    assert.ok(ids.includes(live), `${live} should be indexed`);
  }
  for (const gone of ["workflow:wf-old", "persona:per-old", "action:act-old", "mission:sch-old"]) {
    assert.ok(!ids.includes(gone), `${gone} is archived and must not be offered`);
  }
});

test("a workflow row carries its published version and opens its Library card", () => {
  const rows = paletteRows(stores({ workflows: [workflow()] }));
  const row = find(rows, "workflow:wf-1");
  assert.equal(row.kind, "workflow");
  assert.match(row.detail, /v8/);
  assert.match(row.detail, /2 reviewers/);
  assert.deepEqual(row.target, {
    kind: "route",
    route: { page: "library", shelf: "workflows", assetId: "wf-1" },
  });
});

test("a draft workflow with validation errors reports them, and is marked for attention", () => {
  const rows = paletteRows(
    stores({ workflows: [workflow({ publishedVersion: null, errorCount: 2 })] }),
  );
  const row = find(rows, "workflow:wf-1");
  assert.equal(row.detail, "2 validation errors");
  assert.equal(row.attention, true);
});

test("a persona row names the runner and model that decide whether it can run at all", () => {
  const rows = paletteRows(stores({ personas: [persona()] }));
  const row = find(rows, "persona:per-1");
  assert.equal(row.detail, "claude · sonnet");
  assert.deepEqual(row.target, {
    kind: "route",
    route: { page: "library", shelf: "personas", assetId: "per-1" },
  });
});

test("an action row names what completes it", () => {
  const rows = paletteRows(stores({ sessionActions: [action()] }));
  const row = find(rows, "action:act-1");
  assert.match(row.detail, /Pull request/);
  assert.deepEqual(row.target, {
    kind: "route",
    route: { page: "library", shelf: "actions", assetId: "act-1" },
  });
});

// ---- the live providers ----------------------------------------------------

test("a run row carries its live status, and opens that exact run", () => {
  const rows = paletteRows(
    stores({ runs: [run({ status: "waiting_for_session", activePersonaNames: ["Code Risk"] })] }),
  );
  const row = find(rows, "run:run-1");
  assert.equal(row.kind, "run");
  // The sentence is `run-model`'s own, quoted rather than re-derived: the palette must not be
  // able to describe a run differently from the Runs page it navigates to.
  assert.match(row.detail, /Waiting for the session/);
  assert.match(row.detail, /Code Risk running/);
  assert.match(row.detail, /round 2\/3/);
  assert.deepEqual(row.target, { kind: "route", route: { page: "runs", runId: "run-1" } });
});

test("a run names the session it is reviewing, so four runs of one workflow differ", () => {
  const source = stores({
    runs: [run({ id: "a", sessionId: "sess-1" }), run({ id: "b", sessionId: "sess-2" })],
    sessionNames: new Map([["sess-1", "pane-fix"], ["sess-2", "docs-sweep"]]),
  });
  const rows = paletteRows(source);
  assert.match(find(rows, "run:a").detail, /^pane-fix · /);
  assert.match(find(rows, "run:b").detail, /^docs-sweep · /);
  // And the session name is searchable, which is how you find "the run on pane-fix".
  assert.deepEqual(
    searchPalette("pane-fix", source).rows.map((row) => row.id),
    ["run:a"],
  );
  // A run with no session, or one whose session has left the fleet, still says what it is
  // doing rather than leaving a dangling separator.
  const orphan = paletteRows(stores({ runs: [run({ id: "c", sessionId: null })] }));
  assert.match(find(orphan, "run:c").detail, /^Waiting for the session · /);
});

test("open runs sort above finished ones, however recently the finished one moved", () => {
  const rows = paletteRows(
    stores({
      runs: [
        run({ id: "done", status: "completed", updatedAt: NOW + 5000 }),
        run({ id: "live", status: "blocked", updatedAt: NOW }),
      ],
    }),
  );
  const runIds = rows.filter((row) => row.kind === "run").map((row) => row.id);
  assert.deepEqual(runIds, ["run:live", "run:done"]);
});

test("an ensemble row reads the daemon's own attention flag, and opens that ensemble", () => {
  const rows = paletteRows(stores({ ensembles: [ensemble()] }));
  const row = find(rows, "ensemble:ens-1");
  assert.equal(row.kind, "ensemble");
  assert.equal(row.attention, true);
  assert.match(row.detail, /Best of N/);
  // The shared operator-voice verb, so a decision reads here as it does in the inbox.
  assert.match(row.detail, /waiting on you/);
  assert.match(row.detail, /3\/3 in/);
  assert.deepEqual(row.target, {
    kind: "route",
    route: { page: "ensembles", ensembleId: "ens-1" },
  });
});

test("a quiet ensemble is not marked for attention", () => {
  const rows = paletteRows(
    stores({ ensembles: [ensemble({ status: "running", attention: false })] }),
  );
  assert.equal(find(rows, "ensemble:ens-1").attention, undefined);
});

test("a mission row reports its cadence, and an unhealthy one is amber", () => {
  const healthy = paletteRows(stores({ schedules: [schedule()] }));
  assert.equal(find(healthy, "mission:sch-1").detail, "0 8 * * 1 · UTC");
  assert.equal(find(healthy, "mission:sch-1").attention, undefined);
  // `health` is the daemon's derivation; the browser reads it rather than recomputing it.
  const sick = paletteRows(stores({ schedules: [schedule({ health: "attention" })] }));
  assert.equal(find(sick, "mission:sch-1").detail, "0 8 * * 1 · needs attention");
  assert.equal(find(sick, "mission:sch-1").attention, true);
  // The panel is the only surface a mission has ever had, so that is where it lands.
  assert.deepEqual(find(sick, "mission:sch-1").target, {
    kind: "open-mission",
    scheduleId: "sch-1",
  });
});

test("a paused mission says so instead of naming a timezone it will not fire in", () => {
  const rows = paletteRows(stores({ schedules: [schedule({ enabled: false })] }));
  assert.equal(find(rows, "mission:sch-1").detail, "0 8 * * 1 · paused");
});

// ---- Do -------------------------------------------------------------------

test("every strategy the build can launch is offered, and only through Dispatch", () => {
  const rows = paletteRows(stores()).filter((row) => row.kind === "strategy");
  assert.ok(rows.length > 0, "the build offers no launchable strategies at all");
  for (const row of rows) {
    assert.equal(paletteKindGroup(row.kind), "do");
    assert.equal(row.target.kind, "launch-ensemble");
  }
  assert.ok(rows.some((row) => row.title.includes("Best of N")));
});

test("the fixed commands only reach affordances that already exist in one step", () => {
  const rows = paletteRows(stores()).filter((row) => row.kind === "command");
  const targets = rows.map((row) => row.target.kind).sort();
  assert.deepEqual(targets, ["bind-workflow", "dispatch", "route", "route", "route"]);
  // The three routes are the Library's own ＋ New cards, which is the whole rule: the palette
  // is a second doorway onto shipped affordances, never a new capability.
  const creating = rows.filter((row) => row.target.kind === "route");
  for (const row of creating) {
    assert.deepEqual(
      row.target.kind === "route" ? row.target.route.page : null,
      "library",
    );
  }
});

// ---- settings --------------------------------------------------------------

test("every settings control is still reachable, carrying its category and anchor", () => {
  const rows = paletteRows(stores()).filter((row) => row.kind === "setting");
  assert.equal(rows.length, SETTINGS_CONTROLS.length);
  for (const control of SETTINGS_CONTROLS) {
    const row = find(rows, `setting:${control.id}`);
    assert.equal(row.title, control.label);
    assert.deepEqual(row.target, {
      kind: "route",
      route: { page: "settings", category: control.category },
      anchor: control.anchor,
    });
  }
});

test("a bound toggle flips in place; every other control jumps to its panel", () => {
  const bound = paletteRows(
    stores({
      settingsBindings: new Map([["format-messages", { get: () => true, set: () => {} }]]),
    }),
  );
  const toggle = find(bound, "setting:format-messages");
  assert.deepEqual(toggle.target, { kind: "toggle", controlId: "format-messages" });
  assert.equal(toggle.switchOn, true);

  // With no binding in hand - which is every page but Settings for the daemon-backed
  // configs - the same control degrades to a jump rather than drawing a dead switch.
  const unbound = paletteRows(stores());
  assert.equal(find(unbound, "setting:format-messages").target.kind, "route");
  assert.equal(find(unbound, "setting:format-messages").switchOn, undefined);
});

test("a risky control can never flip from a row, even with a binding forced in", () => {
  // The D5 exemption, held from the palette's side: YOLO's consent copy has to be on screen
  // when it changes, so a binding that somehow reached the map must still not arm a switch.
  const rows = paletteRows(
    stores({ settingsBindings: new Map([["yolo", { get: () => true, set: () => {} }]]) }),
  );
  const row = find(rows, "setting:yolo");
  assert.equal(row.target.kind, "route");
  assert.equal(row.switchOn, undefined);
});

// ---- search ----------------------------------------------------------------

test("one query reaches across kinds, and each hit is grouped by what it does", () => {
  const source = stores({
    workflows: [workflow({ id: "wf-rev", name: "Review gate" })],
    runs: [run({ id: "run-rev", workflowName: "Review gate" })],
    ensembles: [ensemble({ id: "ens-rev", title: "review-discovery" })],
    personas: [persona({ id: "per-rev", name: "Reviewer" })],
  });
  const { groups, rows, kinds } = searchPalette("review", source);
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes("workflow:wf-rev"));
  assert.ok(ids.includes("run:run-rev"));
  assert.ok(ids.includes("ensemble:ens-rev"));
  assert.ok(ids.includes("persona:per-rev"));
  // Groups are the three verbs, in order, and only the ones with rows. "review" reaches all
  // three: the assets above, the binding command, and the Inspector's controls.
  assert.deepEqual(groups.map((group) => group.label), ["Jump to", "Do", "Settings"]);
  // The flat row list is the render order, which is what roving selection indexes into.
  assert.deepEqual(ids, groups.flatMap((group) => group.rows).map((row) => row.id));
  assert.ok(kinds.includes("workflow") && kinds.includes("run") && kinds.includes("setting"));
});

test("a query matches keywords and the kind chip, not just the title", () => {
  const source = stores({ ensembles: [ensemble()] });
  // "decision" is nowhere in the title or the detail line; it is why you would search.
  assert.ok(searchPalette("decision", source).rows.some((row) => row.id === "ensemble:ens-1"));
  // And typing the kind narrows to it, which is what makes the chips worth reading.
  assert.ok(searchPalette("ensemble", source).rows.some((row) => row.id === "ensemble:ens-1"));
});

// The settings half has to keep working exactly as the ⌘K it grew out of did - these are
// that palette's own cases, run through the provider registry that replaced its matcher.
test("a settings query still lands on its control, exactly as it did before the palette", () => {
  const hits = searchPalette("soak", stores()).rows;
  assert.ok(hits.some((row) => row.id === "setting:soak"));
  assert.ok(searchPalette("allowlist", stores()).rows.some((row) => row.id === "setting:trust-grants"));
  // Keywords still reach a control whose label says none of this.
  const retention = searchPalette("retention", stores()).rows;
  assert.ok(retention.some((row) => row.id === "setting:workflow-retention"));
  const live = searchPalette("live delivery", stores()).rows;
  assert.ok(live.some((row) => row.id === "setting:workflow-live-delivery"));
});

test("searching a specific shortcut's name lands on that action's own binding", () => {
  // The regression an Inspector review caught in the settings-only palette: a query for one
  // action must reach ITS row, not the top of the Keyboard panel.
  const dispatch = ACTIONS.find((a) => a.id === "dispatch")!;
  const hits = searchPalette(dispatch.label, stores()).rows;
  assert.ok(
    hits.some((row) => row.id === "setting:keyboard-dispatch"),
    `"${dispatch.label}" did not surface its own keyboard binding`,
  );
});

test("a settings panel is reachable by name and by its registry keywords", () => {
  const rows = paletteRows(stores()).filter((row) => row.kind === "panel");
  assert.equal(rows.length, SETTINGS_CATEGORIES.length);
  for (const category of SETTINGS_CATEGORIES) {
    const row = find(rows, `panel:${category.id}`);
    assert.deepEqual(row.target, {
      kind: "route",
      route: { page: "settings", category: category.id },
    });
    // The rail's own icon, so the row looks like the row it lands on.
    assert.equal(row.glyph, category.icon);
  }
  // "hotkey" is a Keyboard keyword and names no control's label - it has to reach the panel.
  assert.ok(
    searchPalette("hotkey", stores()).rows.some((row) => row.id === "panel:keyboard"),
    "a category keyword should still offer the whole panel as a jump",
  );
});

test("rows needing the operator sort to the top of their own group, never out of it", () => {
  const source = stores({
    workflows: [workflow({ id: "wf-a", name: "aaa review" })],
    ensembles: [ensemble({ id: "ens-z", title: "zzz review", attention: true })],
  });
  const { groups } = searchPalette("review", source);
  const jump = groups.find((group) => group.group === "jump");
  assert.ok(jump);
  // The amber ensemble leads even though its provider runs after workflows and its title
  // sorts last - and it is still under "Jump to", not promoted into "Do".
  assert.equal(jump.rows[0]?.id, "ensemble:ens-z");
  assert.ok(jump.rows.every((row) => paletteKindGroup(row.kind) === "jump"));
});

test("the empty query previews what needs you, then everything you can start", () => {
  const { rows, groups } = searchPalette("", stores({ ensembles: [ensemble()] }));
  assert.equal(rows[0]?.id, "ensemble:ens-1", "the amber ensemble should lead the preview");
  // The Do group survives the preview whole - it is half the answer to "what now?", so it
  // must not be crowded out by a fleet full of amber.
  const doGroup = groups.find((group) => group.group === "do");
  assert.ok(doGroup);
  assert.deepEqual(
    doGroup.rows.map((row) => row.id).sort(),
    paletteRows(stores())
      .filter((row) => paletteKindGroup(row.kind) === "do")
      .map((row) => row.id)
      .sort(),
  );
  // And no settings, which are never what you want unprompted.
  assert.ok(!groups.some((group) => group.group === "settings"));
});

test("an empty preview caps the amber rows so the verbs stay on screen", () => {
  const many = Array.from({ length: 9 }, (_, i) => ensemble({ id: `ens-${i}` }));
  const { rows } = searchPalette("", stores({ ensembles: many }));
  assert.equal(rows.filter((row) => row.kind === "ensemble").length, 4);
});

test("no match is an empty result, not a fallback to everything", () => {
  const { rows, groups } = searchPalette("zzzznothing", stores({ workflows: [workflow()] }));
  assert.deepEqual(rows, []);
  assert.deepEqual(groups, []);
});

// ---- the kind filter -------------------------------------------------------

test("filtering to a kind keeps only that kind, and keeps every kind cyclable", () => {
  const source = stores({
    workflows: [workflow({ name: "Review gate" })],
    runs: [run({ workflowName: "Review gate" })],
  });
  const all = searchPalette("review", source);
  const filtered = searchPalette("review", source, "run");
  assert.ok(filtered.rows.length > 0);
  assert.ok(filtered.rows.every((row) => row.kind === "run"));
  // `kinds` is computed BEFORE the filter narrows, so one press of tab cannot strand you on
  // a kind with nowhere left to cycle to.
  assert.deepEqual(filtered.kinds, all.kinds);
});

test("tab cycles through the kinds present and back out to everything", () => {
  const kinds: PaletteKind[] = ["workflow", "run", "setting"];
  assert.equal(nextPaletteKind(kinds, null), "workflow");
  assert.equal(nextPaletteKind(kinds, "workflow"), "run");
  assert.equal(nextPaletteKind(kinds, "run"), "setting");
  // Back to "everything", so the same key that set the filter also clears it.
  assert.equal(nextPaletteKind(kinds, "setting"), null);
  assert.equal(nextPaletteKind([], "run"), null);
  // A filter whose kind has been typed away narrows to what is left rather than silently
  // widening back to everything under the operator.
  assert.equal(nextPaletteKind(kinds, "ensemble"), "workflow");
});
